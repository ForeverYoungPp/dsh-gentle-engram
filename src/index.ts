/**
 * dsh-gentle-engram — Engram persistent memory for DeepSeek Harness.
 *
 * The plugin talks to an `engram serve` HTTP endpoint rather than bridging
 * Engram's MCP server. That is a deliberate architectural choice: only the HTTP
 * API can resolve a project from *this session's* working directory
 * (`GET /project/current?cwd=`) and report whether that directory is ambiguous
 * rather than guessing a project for it. See docs/DESIGN.md.
 *
 * @module dsh-gentle-engram
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveConfig, type RawEngramConfig } from './config.ts'
import {
  ArchiveOutcome,
  archiveCompaction,
  archiveSummary,
  blocksToText,
  buildRecoveryNotice,
  passivePayload,
  PASSIVE_CAPTURE_LIMIT,
  warnCapture,
} from './capture.ts'
import { createClient, type Logger } from './engram/client.ts'
import { ambiguityGuidance, resolveProject } from './engram/project.ts'
import { createServerManager } from './engram/server.ts'
import type { JsonValue } from './json.ts'
import { PROTOCOL_CONTEXT_NAME, PROTOCOL_CONTEXT_ORDER, PROTOCOL_TEXT } from './protocol.ts'
import { redactText } from './redaction.ts'
import { createRegistration } from './registration.ts'
import { createSessionRegistry, DRAIN_TIMEOUT_MS, type SessionAgent, type SessionState } from './session.ts'
import { registerTools, requireProject } from './tools.ts'

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

/** Cancels one Cordis event registration; the boolean reports whether it was attached. */
type EventDisposer = () => boolean

/** The fiber `inject()` returns. Only its disposal is part of this surface. */
interface InjectionFiber {
  readonly dispose: () => Promise<void>
}

/** The Cordis surface this plugin uses. */
interface PluginContext {
  readonly logger: Logger
  readonly tools: { register(definition: unknown): () => void }
  on(event: string, listener: (...args: never[]) => unknown): EventDisposer
  inject(deps: readonly string[], callback: (scope: PluginContext & { readonly systemPrompt: SystemPromptService }) => void): InjectionFiber
}

/**
 * How long a *failed* project resolution is trusted before it is retried.
 *
 * A resolved project is final for the session; a failure is not. Adding
 * `.engram/config.json` to an ambiguous workspace mid-session has to take
 * effect without a restart, so a failure expires instead of being cached for
 * the session's life.
 */
const PROJECT_RETRY_MS = 30_000

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

export function apply(ctx: PluginContext, rawConfig?: RawEngramConfig): void {
  const config = resolveConfig(rawConfig, message => ctx.logger.warn(`engram config: ${message}`))
  const client = createClient(config, ctx.logger)
  const server = createServerManager(config, client, ctx.logger)
  const sessions = createSessionRegistry(ctx.logger)

  const summarize = async (state: SessionState, content: string): Promise<JsonValue> => {
    const project = requireProject(state)
    return archiveSummary(client, state, project, redactText(content))
  }

  const OWN_TOOL_NAMES = new Set(registerTools(
    definition => ctx.tools.register(definition),
    { client, sessions, logger: ctx.logger, config, summarize, startSession, ensureRegistered },
  ))

  /**
   * Warm one session's read-only state: spawn/reuse the server, then resolve
   * the project.
   *
   * This writes nothing to Engram. It is driven by an `emit` lifecycle event
   * that the harness does not await, so it races the first model step by
   * design.
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
        if (state.cwd.trim().length === 0) {
          // No directory at all was reported, so the config-file guidance the
          // ambiguity path gives cannot help this session.
          ctx.logger.warn('engram: this session did not report a working directory, so Engram cannot attribute its memory to a project. Start DeepSeek Harness from inside the repository you want memory for.')
          return
        }
        const available = resolution.kind === 'failed' ? resolution.available : []
        ctx.logger.warn(`engram: ${ambiguityGuidance(available)}`)
        return
      }
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
   * Registration and lease renewal for every session this instance serves.
   *
   * Deferred to the first write on purpose: registering every agent the harness
   * publishes left an empty Engram session behind for every workspace the GUI
   * had merely reopened, and empty rows crowd the recent-sessions block Engram
   * renders. An agent that never produces memory should not appear in Engram.
   */
  const registration = createRegistration({ client, logger: ctx.logger })

  /**
   * Ensure the calling session's row exists, once its project is resolved.
   *
   * @param state - the calling agent's session state.
   * @returns whether the row exists.
   */
  async function ensureRegistered(state: SessionState): Promise<boolean> {
    const project = state.project?.kind === 'resolved' ? state.project.project : undefined
    return registration.ensureRegistered(state, project)
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
      return archiveCompaction(client, state, project, summary)
    })
    // The notice carries the archive outcome and nothing else. Engram can also
    // hand back this session's own recovery context (`GET /context/compaction`),
    // which used to be injected here: it re-listed the observations and prompts
    // this session had just produced — up to ~10 KB. The model can pull that
    // content itself with `mem_context`. The summary is still archived above, so
    // not reading it back loses nothing.
    state.pendingNotice = buildRecoveryNotice(project, undefined, outcome)
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
      if (typeof cwd !== 'string' || cwd.trim().length === 0) {
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
      // The project comes from this session's resolution. Defence in depth:
      // POST /prompts attributes from the body and session row, and registration
      // already requires a resolved project, so this cannot fire today.
      const project = requireProject(state)
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
      // Same defence-in-depth gate as capturePrompt: the project comes from
      // this session's resolution. POST /observations/passive attributes from
      // the body and session row, so it cannot fire once registration passed.
      const project = requireProject(state)
      await client.bestEffort('/observations/passive', {
        method: 'POST',
        body: {
          session_id: state.engramSessionId,
          project,
          // Already bounded and gate-approved by passivePayload, which keeps
          // the learning header that Engram's parser needs.
          content: redactText(text),
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
    // One call decides both: a returned string is the exact payload sent, and
    // undefined means there is no learning section to extract.
    const payload = passivePayload(text, PASSIVE_CAPTURE_LIMIT)
    if (payload === undefined) return
    void captureResult(sessions.ensure(agent), payload, toolName).catch((error: unknown) => warnCapture(ctx.logger, 'passive capture', error))
  }) as never)

  // Serial dispatch: awaiting here delays turn end until the session's writes
  // settle. Returning a non-null value would bail the chain and silently skip
  // every later turn-stopping listener, so this deliberately resolves void.
  ctx.on('agent/turn-stopping', (async (payload: { agent?: { id: string } }) => {
    const state = sessions.get(payload.agent?.id)
    if (state === undefined) return
    await sessions.drain(state, DRAIN_TIMEOUT_MS)
  }) as never)

  // Disposal releases local state and nothing else. The Engram row is left
  // open on purpose: Engram treats `ended_at` as terminal and can never reopen
  // it, so ending here would destroy the binding a resumed session needs under
  // the same agent id. Liveness is the runtime lease that registration renews
  // (Engram drops a lapsed row from omitted-session resolution on its own), and
  // terminal state belongs to `mem_session_end`, where a human or the model
  // actually declares the work over.
  ctx.on('agent/disposed', ((payload: { agent?: { id: string } }) => {
    const id = payload.agent?.id
    if (id === undefined) return
    const state = sessions.get(id)
    // Marked on the state, not on the agent id: a resume builds a new state for
    // the same id, so this cannot re-arm the dead incarnation's queued work.
    if (state !== undefined) state.released = true
    // Work already queued for this session keeps its own reference to `state`,
    // so it still lands (unless it has to register, which a released state
    // refuses); dropping the map entry only stops new work from reusing the
    // incarnation that just went away.
    if (state !== undefined) void sessions.drain(state, DRAIN_TIMEOUT_MS)
    sessions.forget(id)
  }) as never)

  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: PROTOCOL_CONTEXT_NAME,
      order: PROTOCOL_CONTEXT_ORDER,
      // Memory is not injected: the model pulls it on demand with
      // `mem_context`, matching the reference Pi adapter. The protocol is the
      // standing contribution, and the one-shot compaction notice below is the
      // only automatic memory-related text — it is consumed here. Synchronous by
      // contract, and DSH re-projects this contribution after a surface
      // replacement, so the protocol survives compaction without re-injection.
      text: (context: AssembleContextLike) => {
        const parts = [PROTOCOL_TEXT]
        const state = context.agent === undefined ? undefined : sessions.get(context.agent.id)
        if (state?.pendingNotice !== undefined) {
          parts.push(state.pendingNotice)
          state.pendingNotice = undefined
        }
        return parts.join('\n\n')
      },
    })
  })
}
