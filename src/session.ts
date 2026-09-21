/**
 * Per-session runtime state.
 *
 * This is a `Map` rather than a `sessionProjections` unit on purpose. A
 * projection is a **pure fold over the session log** — its `apply` must derive
 * state from committed events. What we hold here is HTTP-derived runtime
 * cache (a resolved project key, fetched context text, an archive outcome,
 * an in-flight registration). None of it can be recomputed by replaying
 * events, and none of it should be persisted into the log. The multi-session
 * correctness property that matters — never sharing one session's project or
 * buffer with another — is provided equally by keying on the agent id.
 *
 * @module dsh-gentle-engram/session
 */

import { setTimeout as sleep } from 'node:timers/promises'
import type { Logger } from './engram/client.ts'
import type { ProjectResolution } from './engram/project.ts'

/** The agent fields this plugin reads. Structurally satisfied by DSH's Agent. */
export interface SessionAgent {
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
}

/** Mutable runtime state for one agent session. */
export interface SessionState {
  /** DSH agent id, which is also the session id. */
  readonly id: string
  /** The session's absolute working directory, captured at session start. */
  readonly cwd: string
  /** Engram session key. Starts as the agent id and is only replaced when that session has already ended. */
  engramSessionId: string
  /** Latest project resolution. */
  project: ProjectResolution | undefined
  /**
   * When that resolution finished.
   *
   * Only used to expire a *failed* resolution: a workspace that gains an
   * `.engram/config.json` mid-session must recover without a restart.
   */
  projectCheckedAt: number
  /** Cached context block, read by the synchronous prompt provider. */
  contextText: string | undefined
  /** Pending compaction-recovery guidance, consumed once by the prompt provider. */
  pendingNotice: string | undefined
  /** Whether the Engram session row exists. */
  registered: boolean
  /**
   * When Engram last confirmed that row.
   *
   * The answer is re-verified periodically: a row can be deleted or ended from
   * outside this plugin, and a registration cached for the life of the process
   * would then 404 every write — or file memories under a closed session.
   */
  registeredAt: number
  /**
   * Whether `mem_session_end` closed that row.
   *
   * The next write then rotates to a fresh Engram session key instead of
   * filing memories under a session that has already ended.
   */
  ended: boolean
  /** In-flight registration, so concurrent callers share one request. */
  registration: Promise<void> | undefined
  /**
   * In-flight project/context warm-up, so concurrent callers share one pass.
   *
   * Warm-up is deliberately separate from registration: resolving the project
   * and fetching context are read-only, while registering creates a row. Only
   * a session that actually produces memory should leave a row behind.
   */
  startup: Promise<void> | undefined
  /** Serialized write tail; always settles. */
  tail: Promise<void>
  /** Outstanding queued operations; `drain` waits for this to reach zero. */
  pending: number
  /** Compaction ids already archived, guarding against re-entrancy. */
  readonly archivedCompactions: Set<string>
}

/** Session state access and write serialization. */
export interface SessionRegistry {
  get(id: string | undefined): SessionState | undefined
  /** Create-on-demand state for one agent. */
  ensure(agent: SessionAgent): SessionState
  forget(id: string): void
  /** Run one operation after every previously queued operation for the session. */
  enqueue<T>(state: SessionState, operation: () => Promise<T>): Promise<T>
  /** Wait for the session's queued work, bounded. */
  drain(state: SessionState, timeoutMs: number): Promise<void>
}

/** Default bound for draining a session's writes at a turn boundary. */
export const DRAIN_TIMEOUT_MS = 5000

/**
 * Create the registry.
 *
 * @param logger - diagnostic sink for dropped state.
 */
export function createSessionRegistry(logger: Logger): SessionRegistry {
  const states = new Map<string, SessionState>()

  return {
    get(id: string | undefined): SessionState | undefined {
      return id === undefined ? undefined : states.get(id)
    },
    ensure(agent: SessionAgent): SessionState {
      const existing = states.get(agent.id)
      if (existing !== undefined) return existing
      const state: SessionState = {
        id: agent.id,
        cwd: agent.session.header.cwd ?? process.cwd(),
        engramSessionId: agent.id,
        project: undefined,
        projectCheckedAt: 0,
        contextText: undefined,
        pendingNotice: undefined,
        registered: false,
        registeredAt: 0,
        ended: false,
        registration: undefined,
        startup: undefined,
        tail: Promise.resolve(),
        pending: 0,
        archivedCompactions: new Set<string>(),
      }
      states.set(agent.id, state)
      return state
    },
    forget(id: string): void {
      if (states.delete(id)) logger.info(`engram: released session state for ${id}`)
    },
    enqueue<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
      state.pending += 1
      const run = state.tail.then(operation)
      // The stored tail always settles, and is the exact object the cleanup
      // compares against — the previous version of this plugin stored a
      // derived promise while comparing the original, so the delete branch was
      // unreachable and every session leaked an entry.
      const settled = run.then(
        () => { state.pending -= 1 },
        () => { state.pending -= 1 },
      )
      state.tail = settled
      return run
    },
    async drain(state: SessionState, timeoutMs: number): Promise<void> {
      // Loop rather than racing one snapshot of the tail: a capture can enqueue
      // while the turn is already ending, and the contract is that the turn
      // waits for this session's writes — not that one particular promise
      // settled. The deadline keeps a dead server from stalling the turn.
      const deadline = Date.now() + timeoutMs
      while (state.pending > 0) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return
        await Promise.race([state.tail, sleep(remaining, undefined, { ref: false })])
      }
    },
  }
}
