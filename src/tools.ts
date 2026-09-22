/**
 * The native Engram tool surface.
 *
 * These replace the `mcp__engram__mem_*` rows this plugin used to depend on.
 * The set is Engram's `agent` MCP profile minus `mem_list_projects`, which has
 * no HTTP route (its handler calls the store directly). `mem_delete` is
 * deliberately absent too: this plugin sends no `Authorization` header, so the
 * route's `requireAuth` check would reject it in an installation that sets
 * `ENGRAM_HTTP_TOKEN` (an unset token leaves the server open, so the route is
 * not the blocker). The tool stays unexposed by decision.
 *
 * Two signatures deviate from the MCP originals. `mem_session_start` and
 * `mem_session_end` take no model-supplied id: session identity is owned by
 * this plugin (see `session.ts`), and letting the model mint session keys
 * would desynchronise registration from every later capture.
 *
 * @module dsh-gentle-engram/tools
 */

import { isAbsolute } from 'node:path'

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { EngramConfig } from './config.ts'
import type { EngramClient, Logger } from './engram/client.ts'
import { EngramHttpError } from './engram/errors.ts'
import { ambiguityGuidance, type ProjectResolution } from './engram/project.ts'
import type { JsonValue } from './json.ts'
import { redactText } from './redaction.ts'
import type { SessionAgent, SessionRegistry, SessionState } from './session.ts'

/** Everything a tool implementation needs. */
export interface ToolDeps {
  readonly client: EngramClient
  readonly sessions: SessionRegistry
  readonly logger: Logger
  readonly config: EngramConfig
  /** Archive one session summary; shared with the compaction path. */
  readonly summarize: (state: SessionState, content: string) => Promise<JsonValue>
  /**
   * Ensure one agent's session state exists. Invoked lazily by every tool, so a
   * call that races the `agent/session-start` notification — or that arrives
   * after a hot reload replaced this plugin instance and its empty registry —
   * still works instead of failing.
   */
  readonly startSession: (agent: SessionAgent) => Promise<void>
  /**
   * Ensure the Engram session row exists, creating it on first use.
   *
   * @param state - the calling agent's session state.
   * @returns whether the row exists, or false when it could not be created.
   * Calling it from inside a queued capture is fine — the rule that matters is
   * that this must never itself be routed through `sessions.enqueue`, or a
   * caller already holding that queue would wait on its own enqueued work.
   */
  readonly ensureRegistered: (state: SessionState) => Promise<boolean>
}

/**
 * One output declaration shared by every tool. `defineTool` rebuilds its
 * wrapper per call, so sharing the object carries no identity requirement.
 */
const ENGRAM_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown): ContentBlock[] => [
    { type: 'text' as const, text: renderValue(value) },
  ],
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '(empty)'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function queryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded.length > 0 ? `?${encoded}` : ''
}

/**
 * Fetch one Engram session row.
 *
 * @param client - the transport to use.
 * @param sessionId - the Engram session key.
 * @returns the row, `null` for an empty body, or `undefined` when Engram has no
 * such session.
 */
async function fetchSessionRow(client: EngramClient, sessionId: string): Promise<JsonValue | null | undefined> {
  try {
    return await client.request<JsonValue>(`/sessions/${encodeURIComponent(sessionId)}`)
  } catch (error: unknown) {
    // A 404 is the only failure that proves the row is absent. Anything else is
    // rethrown: reading a transport error as "no session" would tell the caller
    // something false about its own data.
    if (error instanceof EngramHttpError && error.status === 404) return undefined
    throw error
  }
}

/** The row's `ended_at`, or `null` when the response carries none. */
function endedAtOf(row: JsonValue): JsonValue {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
  return (row as Record<string, JsonValue>).ended_at ?? null
}

/**
 * Resolve the calling agent's session state and wait for its read-only warm-up
 * (project resolution, context cache).
 *
 * This deliberately does NOT create the Engram session row. Reading memory is
 * not a reason to leave a row behind, and an agent that never writes anything
 * should not show up in Engram at all. Write paths use {@link sessionForWrite}.
 *
 * Lazily re-initialising matters in two cases: a tool call can win the race
 * against the non-awaited `agent/session-start` notification, and a hot reload
 * gives the plugin a fresh empty registry while the agent is still running.
 */
async function sessionFor(exec: ToolRunContext, deps: ToolDeps): Promise<SessionState> {
  const agent = exec.agent as SessionAgent | undefined
  if (agent === undefined) throw new Error('Engram memory tools require an agent session')
  const state = deps.sessions.ensure(agent)
  await deps.startSession(agent)
  return state
}

/**
 * Resolve the session state and guarantee the Engram row exists.
 *
 * Engram enforces `FOREIGN KEY (session_id) REFERENCES sessions(id)` on both
 * `observations` and `user_prompts`, so a write attributed to an unregistered
 * session is rejected by the store. Failing here instead keeps the error
 * legible, and a failed attempt is retried on the next call rather than being
 * remembered as a success.
 */
async function sessionForWrite(exec: ToolRunContext, deps: ToolDeps): Promise<SessionState> {
  const state = await sessionFor(exec, deps)
  if (!(await deps.ensureRegistered(state))) {
    throw new Error('Engram memory is not available for this session yet: the session row could not be registered. Run mem_doctor to check the Engram server.')
  }
  return state
}

/** Fail-closed gate: no write or recall without a resolved project. */
export function requireProject(state: SessionState): string {
  // A session that never named a directory has no workspace to attribute
  // memory to, so the config-file guidance below cannot help it.
  if (state.cwd.trim().length === 0) {
    throw new Error(`Engram cannot tell which project this session's memory belongs to: the session did not report a working directory. Start DeepSeek Harness from inside the repository you want memory for.`)
  }
  const project: ProjectResolution | undefined = state.project
  if (project === undefined) throw new Error('Engram project resolution has not completed for this workspace yet')
  if (project.kind === 'resolved') return project.project
  if (project.kind === 'failed') {
    throw new Error(`Engram cannot resolve this workspace's project: ${project.reason}. ${ambiguityGuidance(project.available)}`)
  }
  throw new Error(`Engram project resolution is pending: ${project.reason}. ${ambiguityGuidance([])}`)
}

const optionalString = (description: string) => ({ type: 'string' as const, description })
const optionalNumber = (description: string) => ({ type: 'number' as const, description })
const optionalBoolean = (description: string) => ({ type: 'boolean' as const, description })
const requiredString = (description: string) => ({ type: 'string' as const, required: true as const, description })
const requiredNumber = (description: string) => ({ type: 'number' as const, required: true as const, description })

const SCOPE = 'Scope: project (default), personal, or global.'
const MATCH_MODE = 'Match mode: all (default, AND) or any (broader recall).'

/**
 * Register every Engram tool in the calling scope.
 *
 * @param register - the tools registry's `register`.
 * @param deps - resolved collaborators.
 * @returns the names of every registered tool.
 */
export function registerTools(
  register: (definition: ReturnType<typeof defineTool>) => () => void,
  deps: ToolDeps,
): string[] {
  const names: string[] = []

  const add = (definition: ReturnType<typeof defineTool>): void => {
    names.push(definition.name)
    register(definition)
  }

  add(defineTool({
    name: 'mem_save',
    description: 'Save a durable memory to Engram. Call this proactively after a bug fix, an architecture or design decision, a non-obvious discovery, a configuration change, an established pattern, or a learned user preference — do not wait to be asked. Use the **What**/**Why**/**Where**/**Learned** structure in content.',
    parameters: {
      title: requiredString('Short, searchable title, e.g. "Fixed FTS5 query sanitization"'),
      content: requiredString('Structured memory content'),
      type: optionalString('Category: bugfix, decision, architecture, discovery, pattern, config, preference'),
      scope: optionalString(SCOPE),
      topic_key: optionalString('Stable topic key so an evolving decision upserts instead of duplicating'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionForWrite(exec, deps)
      const project = requireProject(state)
      return deps.client.request('/observations', {
        method: 'POST',
        signal: exec.signal,
        body: {
          session_id: state.engramSessionId,
          project,
          title: args.title,
          content: redactText(args.content),
          type: args.type ?? 'manual',
          scope: args.scope ?? 'project',
          ...args.topic_key === undefined ? {} : { topic_key: args.topic_key },
        },
      })
    },
  }))

  add(defineTool({
    name: 'mem_search',
    description: 'Search persistent Engram memory for past work, decisions, or context. Scoped to this session\'s resolved project; all_projects is an explicit cross-project sweep to use only when the user explicitly asks for one, never an automatic fallback, because it returns other projects\' memories into this session.',
    parameters: {
      query: requiredString('Search query — natural language or keywords'),
      type: optionalString('Filter by observation type'),
      scope: optionalString(SCOPE),
      limit: optionalNumber('Maximum results'),
      match_mode: optionalString(MATCH_MODE),
      all_projects: optionalBoolean('Search across every project; explicit cross-project sweep, not a fallback'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      // An omitted project is resolved by the Engram server against its own
      // working directory, which no session owns. So there are exactly two
      // states: this session's resolved project, or an explicit all_projects
      // widening.
      const project = args.all_projects === true ? undefined : requireProject(state)
      return deps.client.request(`/search${queryString({
        q: args.query,
        type: args.type,
        scope: args.scope,
        limit: args.limit,
        match_mode: args.match_mode,
        project,
        all_projects: args.all_projects,
      })}`, { signal: exec.signal })
    },
  }))

  add(defineTool({
    name: 'mem_context',
    description: 'Read recent memory context from previous sessions in the active project. Call this at session start or after a compaction.',
    parameters: {
      scope: optionalString(SCOPE),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      return deps.client.request(`/context${queryString({ project: requireProject(state), scope: args.scope })}`, { signal: exec.signal })
    },
  }))

  add(defineTool({
    name: 'mem_stats',
    description: 'Report operational statistics for this session\'s project: sessions, observations and prompts. all_projects is an explicit cross-project sweep to use only when the user explicitly asks for one, never an automatic fallback.',
    parameters: {
      all_projects: optionalBoolean('Report every project; explicit cross-project sweep, not a fallback'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      // Same two states as mem_search: this session's resolved project, or an
      // explicit all_projects widening.
      const project = args.all_projects === true ? undefined : requireProject(state)
      return deps.client.request(`/stats${queryString({ project, all_projects: args.all_projects })}`, { signal: exec.signal })
    },
  }))

  add(defineTool({
    name: 'mem_timeline',
    description: 'Show the observations surrounding one memory by id, to recover what it was saved alongside. Scoped to this session\'s resolved project; there is no cross-project widening for one observation\'s neighbours.',
    parameters: {
      observation_id: requiredNumber('Observation id to center on'),
      before: optionalNumber('Number of observations before'),
      after: optionalNumber('Number of observations after'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      return deps.client.request(`/timeline${queryString({
        observation_id: args.observation_id,
        before: args.before,
        after: args.after,
        project: requireProject(state),
      })}`, { signal: exec.signal })
    },
  }))

  add(defineTool({
    name: 'mem_session_summary',
    description: 'Save an end-of-session summary. Call this before ending a session or saying "done", using the Goal / Instructions / Discoveries / Accomplished / Next Steps / Relevant Files structure. Discoveries is the most valuable section.',
    parameters: {
      content: requiredString('Full session summary in the documented structure'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionForWrite(exec, deps)
      return deps.summarize(state, args.content)
    },
  }))

  add(defineTool({
    name: 'mem_session_start',
    description: 'Report and ensure the Engram session binding for this session. The plugin owns session identity, so no identifier is accepted.',
    parameters: {},
    output: ENGRAM_OUTPUT,
    execute: async (_args, exec) => {
      const state = await sessionForWrite(exec, deps)
      const project = requireProject(state)
      return { session_id: state.engramSessionId, project, directory: state.cwd, registered: state.registered }
    },
  }))

  add(defineTool({
    name: 'mem_session_end',
    description: 'Mark this Engram session as completed, with an optional summary. The plugin closes sessions on its own; call this only when the user explicitly ends the work. A later memory write starts a new Engram session instead of reopening this one.',
    parameters: {
      summary: optionalString('Summary of what was accomplished'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      // sessionFor, not sessionForWrite: closing a session that never wrote
      // anything must not create the row it is about to close. An empty session
      // in Engram is exactly the noise lazy registration exists to avoid.
      const state = await sessionFor(exec, deps)
      const sessionId = state.engramSessionId
      // Engram's end route is not idempotent: every call rewrites `summary`
      // (with NULL when none is given) and moves `ended_at` forward, so ending
      // twice erases whatever the first call recorded. One GET answers both
      // questions — does the row exist, and is it already closed.
      const row = await fetchSessionRow(deps.client, sessionId)
      if (row === undefined || row === null) {
        // The row is gone (`engram delete session`, a rollback). Forget the
        // cached registration so the next write re-creates it instead of
        // trusting a row Engram no longer has.
        state.registered = false
        state.ended = false
        return { ended: false, session_id: sessionId, note: 'No Engram session existed for this session yet, so there was nothing to end.' }
      }
      if (endedAtOf(row) !== null) {
        state.ended = true
        state.registered = false
        return { ended: false, session_id: sessionId, note: 'This Engram session had already ended; its summary and end time were left untouched.' }
      }
      // Queued behind this session's captured writes so no prompt or passive
      // capture lands after the row closes. Tool-path writes (mem_save and
      // friends) are not queued; DSH runs our tools exclusively, which is what
      // keeps those ordered.
      const ended = await deps.sessions.enqueue(state, async () =>
        deps.client.request<JsonValue>(`/sessions/${encodeURIComponent(sessionId)}/end`, {
          method: 'POST',
          signal: exec.signal,
          body: { summary: args.summary === undefined ? '' : redactText(args.summary) },
        }),
      )
      // The row is closed for good. Drop the local registration so the next
      // write rotates to a fresh Engram session (registerSession) instead of
      // filing memories under a session that has already ended.
      state.ended = true
      state.registered = false
      return ended
    },
  }))

  add(defineTool({
    name: 'mem_get_observation',
    description: 'Fetch the full, untruncated content of one memory by id, after a search returned a truncated preview.',
    parameters: {
      id: requiredNumber('Observation id to retrieve'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request(`/observations/${encodeURIComponent(String(args.id))}`, { signal: exec.signal }),
  }))

  add(defineTool({
    name: 'mem_suggest_topic_key',
    description: 'Suggest a stable topic key for an observation, so later saves on the same subject upsert instead of accumulating duplicates.',
    parameters: {
      title: optionalString('Observation title'),
      type: optionalString('Observation type/category'),
      content: optionalString('Observation content'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request('/topic-keys/suggest', { method: 'POST', signal: exec.signal, body: { title: args.title, type: args.type, content: args.content } }),
  }))

  add(defineTool({
    name: 'mem_capture_passive',
    description: 'Send text to Engram for passive extraction of structured learnings. Engram decides what is worth persisting; raw output is not stored as an observation by itself.',
    parameters: {
      content: requiredString('Text that may contain learnings, ideally with a "## Key Learnings" section'),
      source: optionalString('Source identifier, e.g. the originating tool name'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionForWrite(exec, deps)
      const project = requireProject(state)
      return deps.client.request('/observations/passive', {
        method: 'POST',
        signal: exec.signal,
        body: { session_id: state.engramSessionId, project, content: redactText(args.content), source: args.source ?? 'dsh-tool' },
      })
    },
  }))

  add(defineTool({
    name: 'mem_save_prompt',
    description: 'Record what the user asked for, so a future session understands their intent. The plugin already captures prompts automatically; call this only to preserve something the automatic capture missed.',
    parameters: {
      content: requiredString("The user's prompt text"),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionForWrite(exec, deps)
      const project = requireProject(state)
      return deps.client.request('/prompts', {
        method: 'POST',
        signal: exec.signal,
        body: { session_id: state.engramSessionId, project, content: redactText(args.content).slice(0, 2000) },
      })
    },
  }))

  add(defineTool({
    name: 'mem_update',
    description: 'Correct an existing memory in place by id. Only the fields you provide change.',
    parameters: {
      id: requiredNumber('Observation id to update'),
      title: optionalString('New title'),
      content: optionalString('New content'),
      type: optionalString('New type/category'),
      scope: optionalString(SCOPE),
      topic_key: optionalString('New topic key'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request(`/observations/${encodeURIComponent(String(args.id))}`, {
        method: 'PATCH',
        signal: exec.signal,
        body: { title: args.title, content: args.content, type: args.type, scope: args.scope, topic_key: args.topic_key },
      }),
  }))

  add(defineTool({
    name: 'mem_current_project',
    description: 'Detect which Engram project this workspace resolves to, and list the known alternatives when it is ambiguous. Call this before saving when the workspace contains several repositories. An explicit cwd must be absolute: a relative one would be resolved against the Engram server process\'s own working directory.',
    parameters: {
      cwd: optionalString('Directory to inspect; defaults to this session\'s working directory'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      const cwd = args.cwd ?? state.cwd
      // A cwd-less `/project/current` is answered from the serving process's
      // own directory, which no session owns. Refuse instead of querying.
      if (cwd.trim().length === 0) {
        throw new Error('Engram cannot inspect an empty working directory: this session reported no working directory, and a cwd-less /project/current is answered from the Engram server\'s own directory. Pass cwd explicitly.')
      }
      // A relative explicit cwd would be resolved by the `engram serve` process
      // against its own directory — a project this session never named.
      if (args.cwd !== undefined && !isAbsolute(args.cwd)) {
        throw new Error('Engram cannot inspect a relative working directory: it would be resolved against the Engram server process\'s own directory, a project this session never named. Pass an absolute path.')
      }
      return deps.client.request(`/project/current${queryString({ cwd })}`, { signal: exec.signal })
    },
  }))

  add(defineTool({
    name: 'mem_judge',
    description: 'Record a verdict on a pending memory conflict that Engram flagged.',
    parameters: {
      judgment_id: requiredString('The relation judgment_id returned with a save response'),
      relation: requiredString('Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict'),
      reason: optionalString('Free-text explanation of the verdict'),
      evidence: optionalString('Supporting evidence'),
      confidence: optionalNumber('Confidence score 0.0..1.0'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request('/conflicts/judge', {
        method: 'POST',
        signal: exec.signal,
        body: { judgment_id: args.judgment_id, relation: args.relation, reason: args.reason, evidence: args.evidence, confidence: args.confidence },
      }),
  }))

  add(defineTool({
    name: 'mem_compare',
    description: 'Persist a semantic verdict you have already reached about how two memories relate.',
    parameters: {
      memory_id_a: requiredNumber('Id of the first observation'),
      memory_id_b: requiredNumber('Id of the second observation'),
      relation: requiredString('Verdict: related | compatible | scoped | conflicts_with | supersedes | not_conflict'),
      confidence: requiredNumber('Confidence score 0.0..1.0'),
      reasoning: requiredString('Brief explanation of the verdict'),
      model: optionalString('Model identifier for provenance'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request('/conflicts/compare', {
        method: 'POST',
        signal: exec.signal,
        body: { memory_id_a: args.memory_id_a, memory_id_b: args.memory_id_b, relation: args.relation, confidence: args.confidence, reasoning: args.reasoning, model: args.model },
      }),
  }))

  add(defineTool({
    name: 'mem_doctor',
    description: 'Run Engram operational diagnostics for the active project. Use this when memory operations fail or return nothing unexpectedly.',
    parameters: {
      check: optionalString('Optional diagnostic check code to run'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      // A request without a project is resolved by the Engram server against its own
      // working directory, not this session's. Fail closed instead of letting it guess.
      const project = requireProject(state)
      return deps.client.request(`/doctor${queryString({ project, check: args.check })}`, { signal: exec.signal })
    },
  }))

  add(defineTool({
    name: 'mem_review',
    description: 'List memories whose review interval has elapsed, or mark one as reviewed to reset its clock. Listing is scoped to this session\'s resolved project; all_projects is an explicit cross-project sweep to use only when the user explicitly asks for one.',
    parameters: {
      action: requiredString('Action: list | mark_reviewed'),
      observation_id: optionalNumber('Observation id, for action=mark_reviewed'),
      limit: optionalNumber('Maximum results, for action=list'),
      all_projects: optionalBoolean('List reviews across every project; explicit, for an ambiguous workspace'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) => {
      const state = await sessionFor(exec, deps)
      if (args.action === 'list') {
        // The same two states as mem_search. A request without a project is
        // resolved by the Engram server against its own working directory, not
        // this session's, so the fail-closed default stays unless the caller
        // explicitly widens.
        const all = args.all_projects === true
        return deps.client.request(`/review${queryString({
          project: all ? undefined : requireProject(state),
          limit: args.limit,
          all_projects: all ? true : undefined,
        })}`, { signal: exec.signal })
      }
      if (args.action === 'mark_reviewed') {
        if (args.observation_id === undefined) throw new Error('observation_id is required for action=mark_reviewed')
        return deps.client.request(`/review/mark_reviewed${queryString({ project: requireProject(state) })}`, {
          method: 'POST',
          signal: exec.signal,
          body: { observation_id: args.observation_id },
        })
      }
      throw new Error('action must be one of: list, mark_reviewed')
    },
  }))

  add(defineTool({
    name: 'mem_pin',
    description: 'Pin a memory so it appears before recent observations in memory context. Pin state is local to this machine.',
    parameters: {
      id: requiredNumber('Observation id to pin'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request(`/observations/${encodeURIComponent(String(args.id))}/pin`, { method: 'PUT', signal: exec.signal }),
  }))

  add(defineTool({
    name: 'mem_unpin',
    description: 'Unpin a memory so it returns to normal recency order.',
    parameters: {
      id: requiredNumber('Observation id to unpin'),
    },
    output: ENGRAM_OUTPUT,
    execute: async (args, exec) =>
      deps.client.request(`/observations/${encodeURIComponent(String(args.id))}/pin`, { method: 'DELETE', signal: exec.signal }),
  }))

  return names
}
