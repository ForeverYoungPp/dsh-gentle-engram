/**
 * dsh-gentle-engram — Engram persistent memory for DeepSeek Harness.
 *
 * The plugin talks to an `engram serve` HTTP endpoint rather than bridging
 * Engram's MCP server. That is a deliberate architectural choice: only the HTTP
 * API can resolve a project from *this session's* working directory
 * (`GET /project/current?cwd=`) and return session-scoped compaction recovery
 * context (`GET /context/compaction?session_id=`). See DESIGN.md.
 *
 * @module dsh-gentle-engram
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveConfig, type RawEngramConfig } from './config.ts'
import {
  ArchiveOutcome,
  archiveCompaction,
  archiveSummary,
  blocksToText,
  buildRecoveryNotice,
  loadCompactionContext,
  warnCapture,
} from './capture.ts'
import { createClient, type Logger } from './engram/client.ts'
import { EngramHttpError } from './engram/errors.ts'
import { ambiguityGuidance, resolveProject } from './engram/project.ts'
import { createServerManager } from './engram/server.ts'
import type { JsonValue } from './json.ts'
import { PROTOCOL_CONTEXT_NAME, PROTOCOL_CONTEXT_ORDER, protocolText } from './protocol.ts'
import { redactText } from './redaction.ts'
import { createSessionRegistry, DRAIN_TIMEOUT_MS, type SessionAgent, type SessionState } from './session.ts'
import { registerTools } from './tools.ts'

export const name = 'dsh-gentle-engram'
export const inject = ['tools']

/** Prompt-context provider input; `agent` is absent on diagnostics. */
interface AssembleContextLike {
  readonly agent?: { readonly id: string }
}

interface SystemPromptService {
  context(entry: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: AssembleContextLike) => string)
  }): () => void
}

/** The Cordis surface this plugin uses. */
interface PluginContext {
  readonly logger: Logger
  readonly tools: { register(definition: unknown): () => void }
  on(event: string, listener: (...args: never[]) => unknown): unknown
  inject(deps: readonly string[], callback: (scope: PluginContext & { readonly systemPrompt: SystemPromptService }) => void): unknown
}

/** Tool names owned by this plugin; excluded from passive capture. */
const OWN_TOOL_NAMES = new Set([
  'mem_save', 'mem_search', 'mem_context', 'mem_session_summary', 'mem_session_start',
  'mem_session_end', 'mem_get_observation', 'mem_suggest_topic_key', 'mem_capture_passive',
  'mem_save_prompt', 'mem_update', 'mem_current_project', 'mem_judge', 'mem_compare',
  'mem_doctor', 'mem_review', 'mem_pin', 'mem_unpin',
])

/**
 * How long a *failed* project resolution is trusted before it is retried.
 *
 * A resolved project is final for the session; a failure is not. Adding
 * `.engram/config.json` to an ambiguous workspace mid-session has to take
 * effect without a restart, so a failure expires instead of being cached for
 * the session's life.
 */
const PROJECT_RETRY_MS = 30_000

/**
 * How long Engram's confirmation of the session row is trusted before it is
 * checked again.
 *
 * `registered` used to be cached for the life of the process, so a row removed
 * behind the plugin's back (`engram delete session`, a CLI end) left the
 * session 404ing every write until a reload. One re-check per minute per session
 * closes that, and the same check re-creates a row that was deleted.
 */
const REGISTRATION_TTL_MS = 60_000

/** Upper bound for one passively captured tool result, mirroring the prompt cap. */
const PASSIVE_CAPTURE_LIMIT = 20_000

/**
 * Engram's passive extractor only reads items from a `## Key Learnings`
 * section (`## Learnings` and `## Aprendizajes Clave` also count); anything
 * else is parsed, discarded, and still costs a request, a queue slot and — since
 * capture registers first — an Engram session row. Mirrors
 * `learningHeaderPattern` in Engram's `internal/store/store.go`.
 */
const LEARNING_SECTION = /^#{2,3}\s+(?:Aprendizajes(?:\s+Clave)?|Key\s+Learnings?|Learnings?):?\s*$/im

/** Extract plain text from a user message's content blocks. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as ContentBlock[])
    .map(block => (block as { type?: unknown; text?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : '')
    .filter(part => part.length > 0)
    .join('\n')
    .trim()
}

/** Extract text from a tool result, which may be blocks or a bare string. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === null || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  return blocksToText(record.content)
}

/**
 * Bound one injected block. Engram returns whole-session context with no size
 * contract, and this text is contributed to every assembly, so an unbounded
 * block would tax every request.
 */
function boundContext(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) return undefined
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 60))}\n...[truncated by dsh-gentle-engram]`
}

/** Read the context text Engram returns, which may be a string or a wrapper. */
function contextTextOf(response: unknown): string | undefined {
  if (typeof response === 'string') return response.trim() || undefined
  if (response === null || typeof response !== 'object') return undefined
  const value = (response as Record<string, unknown>).context
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function apply(ctx: PluginContext, rawConfig?: RawEngramConfig): void {
  const config = resolveConfig(rawConfig, message => ctx.logger.warn(`engram config: ${message}`))
  const client = createClient(config, ctx.logger)
  const server = createServerManager(config, client, ctx.logger)
  const sessions = createSessionRegistry(ctx.logger)

  const summarize = async (state: SessionState, content: string): Promise<JsonValue> => {
    const project = state.project?.kind === 'resolved' ? state.project.project : undefined
    if (project === undefined) throw new Error(`Engram cannot resolve this workspace's project. ${ambiguityGuidance([])}`)
    return archiveSummary(client, state, project, redactText(content), undefined)
  }

  const disposers = registerTools(
    definition => ctx.tools.register(definition) as unknown as () => void,
    { client, sessions, logger: ctx.logger, config, summarize, startSession, ensureRegistered },
  )

  /**
   * Warm one session's read-only state: spawn/reuse the server, resolve the
   * project, then cache the context block.
   *
   * This writes nothing to Engram. It is driven by an `emit` lifecycle event
   * that the harness does not await, so it races the first model step by
   * design; the prompt provider tolerates an unwarmed cache and simply
   * contributes the protocol until the context arrives.
   *
   * `state.project` doubles as the warmed marker — the resolution is cached for
   * the session's life, exactly once, and a failed server ensure leaves it
   * unset so the next caller retries instead of remembering the failure.
   */
  async function startState(state: SessionState): Promise<void> {
    if (state.project?.kind === 'resolved') return
    if (state.project !== undefined && Date.now() - state.projectCheckedAt < PROJECT_RETRY_MS) return
    state.startup ??= (async () => {
      try {
        await server.ensure()
      } catch {
        // Reported by the manager; tools surface their own structured errors.
        return
      }

      const resolution = await resolveProject(client, state.cwd)
      state.project = resolution
      state.projectCheckedAt = Date.now()
      if (resolution.kind !== 'resolved') {
        const available = resolution.kind === 'failed' ? resolution.available : []
        ctx.logger.warn(`engram: ${ambiguityGuidance(available)}`)
        return
      }

      const context = await client.bestEffort(`/context?project=${encodeURIComponent(resolution.project)}`)
      state.contextText = boundContext(contextTextOf(context), config.contextLimit)
    })().finally(() => {
      state.startup = undefined
    })
    return state.startup
  }

  /** Warm the session state for one agent. */
  async function startSession(agent: SessionAgent): Promise<void> {
    return startState(sessions.ensure(agent))
  }

  /**
   * Create the Engram session row on first use.
   *
   * Registration is deferred to the first write on purpose. This plugin used
   * to register every agent the harness publishes, whenever it publishes it,
   * which left an empty Engram session behind for every workspace the GUI had
   * merely reopened — and those empty rows compete with real sessions for the
   * fixed-size recent-sessions block that Engram injects. An agent that never
   * produces memory should not appear in Engram at all.
   *
   * A failed attempt is not remembered: `registered` only becomes true after
   * Engram acknowledges the row, so the next write retries.
   *
   * @param state - the calling agent's session state.
   * @returns whether the row exists.
   */
  async function ensureRegistered(state: SessionState): Promise<boolean> {
    const confirmed = state.registered
    if (confirmed && Date.now() - state.registeredAt < REGISTRATION_TTL_MS) return true
    if (state.project?.kind !== 'resolved') return false
    try {
      // Deliberately not routed through sessions.enqueue: handleCompaction
      // already holds that queue while it archives, and a nested await on the
      // same queue would wait for itself until the drain timeout.
      await registerSession(state, state.project.project)
    } catch (error: unknown) {
      warnCapture(ctx.logger, 'session registration', error)
      // A failed *re*-verification must not break a session that was working:
      // keep the previous answer and let the write itself report a row that is
      // really gone. Only a first registration reports failure.
      return confirmed
    }
    return state.registered
  }

  /**
   * Register the Engram session row.
   *
   * The agent id doubles as the session key so a resumed session keeps its
   * binding. Engram's HTTP create path returns 201 for an id that has already
   * ended without clearing `ended_at`, which would strand the session as a
   * zombie, so an ended row is detected up front and replaced with a fresh key.
   *
   * The row can already be over in two ways: `mem_session_end` closed it
   * (`state.ended`), or something outside this plugin did, which only the row
   * itself can report. Both rotate the key.
   */
  async function registerSession(state: SessionState, project: string): Promise<void> {
    state.registration ??= (async () => {
      if (state.ended || await rowHasEnded(state.engramSessionId)) {
        ctx.logger.warn(`engram: session ${state.engramSessionId} had already ended; starting a fresh Engram session`)
        state.engramSessionId = randomUUID()
      }
      state.ended = false
      await client.request('/sessions', {
        method: 'POST',
        body: { id: state.engramSessionId, project, directory: state.cwd },
      })
      state.registered = true
      state.registeredAt = Date.now()
    })().finally(() => {
      state.registration = undefined
    })
    return state.registration
  }

  /**
   * Whether Engram already closed this session row.
   *
   * Only a 404 is read as "no such row"; every other failure propagates. Swallow
   * a transport error here and the caller concludes "still open", reuses the
   * key, and Engram answers 201 without clearing `ended_at` — so the session
   * would file memories for the rest of the process's life while looking closed,
   * and nothing would say so.
   */
  async function rowHasEnded(sessionId: string): Promise<boolean> {
    let existing: { ended_at?: unknown } | null
    try {
      existing = await client.request<{ ended_at?: unknown }>(`/sessions/${encodeURIComponent(sessionId)}`)
    } catch (error: unknown) {
      if (error instanceof EngramHttpError && error.status === 404) return false
      throw error
    }
    return existing !== null && existing.ended_at !== null && existing.ended_at !== undefined
  }

  /** Archive one compacted summary and queue its recovery guidance. */
  async function handleCompaction(sessionId: string, event: { data?: unknown }): Promise<void> {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    const data = (event.data ?? {}) as Record<string, unknown>
    const compactionId = typeof data.compactionId === 'string' ? data.compactionId : undefined
    if (compactionId !== undefined && state.archivedCompactions.has(compactionId)) return
    if (compactionId !== undefined) state.archivedCompactions.add(compactionId)

    // A compaction can land before the first write, so warm the state and
    // create the row here instead of assuming an earlier operation did it.
    await startState(state)
    const summary = blocksToText(data.summary)
    const project = state.project?.kind === 'resolved' ? state.project.project : undefined
    // Registered OUTSIDE the queue below — nesting it there would make this
    // wait on its own enqueued work. A failure is reported as Unavailable,
    // never as Confirmed, so the recovery notice stays honest about whether
    // the summary actually reached Engram.
    let ready = false
    if (project !== undefined && summary.length > 0) ready = await ensureRegistered(state)
    if (project === undefined || summary.length === 0 || !ready) {
      state.pendingNotice = buildRecoveryNotice(project ?? 'unknown', undefined, ArchiveOutcome.Unavailable)
      return
    }

    // Serialized with the session's other writes, which is also the
    // re-entrancy guard: a second compaction arriving while this archive is in
    // flight queues behind it instead of interleaving.
    const outcome = await sessions.enqueue(state, async () => {
      // `mem_session_end` may have closed this row while the archive waited in
      // the queue, and the check above ran before that. Re-verify here so the
      // summary lands in a live session — safe from inside the queue because
      // registration never enqueues.
      if (!state.registered) await ensureRegistered(state)
      const result = await archiveCompaction(client, state, project, summary)
      const context = await loadCompactionContext(client, state)
      return { result, context }
    })
    state.pendingNotice = buildRecoveryNotice(project, boundContext(outcome.context, config.contextLimit), outcome.result)
  }

  ctx.on('agent/session-start', ((payload: { agent: SessionAgent }) => {
    void startSession(payload.agent).catch((error: unknown) => {
      warnCapture(ctx.logger, 'session start', error)
    })
  }) as never)

  // Observe compaction. These listeners are NOT awaited by the session log,
  // so every failure has to be handled here.
  ctx.on('session/event', ((session: { id?: string } & SessionAgent['session'], event: { type?: string; data?: unknown }) => {
    if (event.type !== 'compaction/summary') return
    const sessionId = session.id
    if (sessionId === undefined) return
    // sessions.ensure, not sessions.get, for the same reason the capture
    // listeners below use it: a hot reload leaves this instance with an empty
    // registry and no session-start re-fires, so a get() here would drop the
    // compaction archive and its recovery guidance in silence. DSH hands the
    // whole session to this listener, so the state is reconstructible — but
    // only from a recorded cwd: falling back to the process directory would
    // attribute the summary to the wrong project.
    if (sessions.get(sessionId) === undefined) {
      const cwd = session.header.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) {
        ctx.logger.warn(`engram: compaction for ${sessionId} arrived with no warm state and no recorded cwd; skipping the archive rather than guessing which project it belongs to`)
        return
      }
      sessions.ensure({ id: sessionId, session })
    }
    void handleCompaction(sessionId, event).catch((error: unknown) => {
      warnCapture(ctx.logger, 'compaction archive', error)
    })
  }) as never)

  /**
   * Capture one user prompt, waiting for warm-up and registration first.
   *
   * Awaiting the gate is the whole point. A prompt arrives within microseconds
   * of the session being published — long before `GET /project/current` has
   * returned — so the previous synchronous `state.project` check silently
   * dropped the first prompt of every fast-starting agent, subagents above all.
   *
   * The whole gate runs as one queued unit, warm-up included. `drain` can only
   * see queued work, so a capture that was still spawning the server when the
   * turn ended used to look like no work at all — and the turn boundary is
   * exactly where the first capture of a session is most likely to still be
   * warming up.
   */
  async function capturePrompt(state: SessionState, text: string): Promise<void> {
    await sessions.enqueue(state, async () => {
      await startState(state)
      if (!(await ensureRegistered(state))) return
      const project = state.project?.kind === 'resolved' ? state.project.project : undefined
      await client.bestEffort('/prompts', {
        method: 'POST',
        body: {
          // Read when the queued operation runs, not when it is queued:
          // registration may have re-keyed the session on an ended agent id.
          session_id: state.engramSessionId,
          project,
          content: redactText(text).slice(0, 2000),
        },
      })
    })
  }

  // Prompt capture. The event also fires for plugin-injected messages, so the
  // source kind is the discriminator — and DSH's source union has no 'human'
  // member, so anything that is not exactly 'user' is skipped.
  ctx.on('agent/inbox/inserted', ((payload: { agent?: SessionAgent; message?: { content?: unknown; source?: { kind?: string } } }) => {
    if (!config.capturePrompts) return
    const agent = payload.agent
    const message = payload.message
    if (agent === undefined || message === undefined) return
    if (message.source?.kind !== 'user') return
    const text = messageText(message.content)
    if (text.length <= 10) return
    // sessions.ensure, not sessions.get: a hot reload leaves this plugin instance
    // with an empty registry while the agent keeps running and no session-start
    // fires again, so a get() here silently disabled capture until the model
    // happened to call a mem_* tool. The event body carries the whole agent, so
    // the state is always reconstructible.
    void capturePrompt(sessions.ensure(agent), text).catch((error: unknown) => warnCapture(ctx.logger, 'prompt capture', error))
  }) as never)

  /** Send one tool result to Engram's passive extractor, once it can be attributed. */
  async function captureResult(state: SessionState, text: string, toolName: string): Promise<void> {
    // Queued as one unit with its gate, for the same reason as capturePrompt.
    await sessions.enqueue(state, async () => {
      await startState(state)
      if (!(await ensureRegistered(state))) return
      const project = state.project?.kind === 'resolved' ? state.project.project : undefined
      await client.bestEffort('/observations/passive', {
        method: 'POST',
        body: {
          session_id: state.engramSessionId,
          project,
          content: redactText(text).slice(0, PASSIVE_CAPTURE_LIMIT),
          source: toolName,
        },
      })
    })
  }

  // Passive capture. Engram's server-side parser decides what becomes a
  // learning, so this only filters out our own tools, failures, and trivia.
  ctx.on('tools/result', ((exec: { agent?: SessionAgent; name?: string }, result: unknown) => {
    if (!config.captureToolResults) return
    const agent = exec.agent
    const toolName = exec.name ?? ''
    if (agent === undefined || OWN_TOOL_NAMES.has(toolName)) return
    if (result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true) return
    const text = resultText(result)
    if (text.length <= 50) return
    if (!LEARNING_SECTION.test(text)) return
    void captureResult(sessions.ensure(agent), text, toolName).catch((error: unknown) => warnCapture(ctx.logger, 'passive capture', error))
  }) as never)

  // Serial dispatch: awaiting here delays turn end until the session's writes
  // settle. Returning a non-null value would bail the chain and silently skip
  // every later turn-stopping listener, so this deliberately resolves void.
  ctx.on('agent/turn-stopping', (async (payload: { agent?: { id: string } }) => {
    const state = sessions.get(payload.agent?.id)
    if (state === undefined) return
    await sessions.drain(state, DRAIN_TIMEOUT_MS)
  }) as never)

  // Disposal is fire-and-forget and the agent is already gone from the
  // registry, so only local state is released here. No summary is written: a
  // hardcoded template saved on every session is noise, and the real summary
  // is the model's job under the session-close protocol.
  ctx.on('agent/disposed', ((payload: { agent?: { id: string } }) => {
    const id = payload.agent?.id
    if (id !== undefined) sessions.forget(id)
  }) as never)

  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: PROTOCOL_CONTEXT_NAME,
      order: PROTOCOL_CONTEXT_ORDER,
      // Synchronous by contract: everything expensive was cached when the
      // session started. DSH re-projects this contribution after a surface
      // replacement, so the protocol survives compaction without re-injection.
      text: (context: AssembleContextLike) => {
        const parts = [protocolText()]
        const state = context.agent === undefined ? undefined : sessions.get(context.agent.id)
        if (state !== undefined && state.contextText !== undefined) {
          parts.push(`### Recovered Engram memory for this project\n\n${state.contextText}`)
        }
        if (state?.pendingNotice !== undefined) {
          parts.push(state.pendingNotice)
          state.pendingNotice = undefined
        }
        return parts.join('\n\n')
      },
    })
  })

  void disposers
}
