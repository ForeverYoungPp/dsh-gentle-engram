/**
 * Engram session registration and lease renewal.
 *
 * Engram's `POST /sessions` is **create-or-renew**: on an open row it refreshes
 * the local 30-minute `runtime_lease_expires_at` without changing the persisted
 * identity. That lease, not `ended_at`, is how Engram tracks liveness, so
 * re-registering the same id on activity is the whole renewal mechanism. Once a
 * lease lapses the row stops being offered to writers that omit a session id,
 * and it never falls back into the legacy activity window — that window is for
 * rows that carry no lease at all, i.e. rows written before Engram 2.1.0 added
 * the column.
 *
 * Reusing the key is therefore the normal case, and it is what keeps a resumed
 * DSH session on its original row. A key is only replaced when it can no longer
 * carry the session:
 *
 * - the row reports `ended_at` — terminal in Engram, with no un-end route. Any
 *   server answers this, which is why the row is read rather than relying on the
 *   status code alone: Engram ≤ 2.0 answers `201` for an already-ended id and
 *   leaves `ended_at` set, so a 409-only check would file memories under a closed
 *   session forever on those servers.
 * - `409 session_already_ended` — the same fact, reported by Engram ≥ 2.1.0. It
 *   also covers the race where the row ends between the read and the write.
 * - `409 session_project_conflict` — `ownership_mode: project_owned` pins a row
 *   to its project, so a workspace that resolved to a different project needs a
 *   new row.
 *
 * Every other failure is transient as far as this module is concerned: a session
 * that was already working keeps its previous answer, and the write itself
 * reports a row that is really gone.
 *
 * @module dsh-gentle-engram/registration
 */

import { randomUUID } from 'node:crypto'

import type { EngramClient, Logger } from './engram/client.ts'
import { EngramHttpError } from './engram/errors.ts'
import type { SessionState } from './session.ts'

/**
 * How long Engram's confirmation of the session row is trusted before it is
 * checked again.
 *
 * `registered` used to be cached for the life of the process, so a row removed
 * behind the plugin's back (`engram delete session`, a CLI end) left the
 * session 404ing every write until a reload. One re-check per minute per session
 * closes that, and the same check re-creates a row that was deleted. It is also
 * what keeps the runtime lease fresh: 60s is comfortably inside the 30 minutes
 * Engram allows, so a session that keeps working never lapses.
 */
export const REGISTRATION_TTL_MS = 60_000

/** Collaborators one registration needs. */
export interface RegistrationDeps {
  readonly client: EngramClient
  readonly logger: Logger
}

/** Session registration for one plugin instance. */
export interface Registration {
  /**
   * Ensure the Engram row for a session exists, creating or renewing it.
   *
   * @param state - the calling agent's session state.
   * @param project - the session's resolved project, or `undefined` while
   * resolution is pending. Nothing is posted without one, because Engram
   * refuses to guess a project for a session.
   * @returns whether the row exists.
   */
  ensureRegistered(state: SessionState, project: string | undefined): Promise<boolean>
}

/**
 * The 409 code that proves a key is unusable, if this is one.
 *
 * @param error - the failure from `POST /sessions`.
 * @returns the Engram error code, or `undefined` when the failure is transient.
 */
function rotationCode(error: unknown): string | undefined {
  if (!(error instanceof EngramHttpError) || error.status !== 409) return undefined
  const code = (error.data as { code?: unknown } | null)?.code
  if (code === 'session_already_ended') return code
  if (code === 'session_project_conflict') return code
  return undefined
}

/**
 * Read one session row's `ended_at`.
 *
 * Only a 404 is read as "no such row" — a deleted row is re-created under the
 * same key by the next registration. Every other failure propagates, because
 * reading a transport error as "still open" is what would strand a session on a
 * closed row.
 *
 * @param client - the transport to use.
 * @param sessionId - the Engram session key.
 */
async function rowHasEnded(client: EngramClient, sessionId: string): Promise<boolean> {
  let existing: { ended_at?: unknown } | null
  try {
    existing = await client.request<{ ended_at?: unknown }>(`/sessions/${encodeURIComponent(sessionId)}`)
  } catch (error: unknown) {
    if (error instanceof EngramHttpError && error.status === 404) return false
    throw error
  }
  return existing !== null && existing.ended_at !== null && existing.ended_at !== undefined
}

/**
 * Create the registration surface.
 *
 * @param deps - resolved collaborators.
 */
export function createRegistration(deps: RegistrationDeps): Registration {
  /**
   * One `POST /sessions` for the session's current key.
   *
   * Registration deliberately does not go through the session write queue:
   * `handleCompaction` already holds that queue while it archives, and a nested
   * await on it would wait for itself until the drain timeout.
   */
  async function postSession(state: SessionState, project: string): Promise<void> {
    await deps.client.request('/sessions', {
      method: 'POST',
      body: {
        id: state.engramSessionId,
        project,
        directory: state.cwd,
        // Without this the server stores the row as `shared`, and shared rows
        // are exempt from its project-mismatch enforcement — so the
        // per-project isolation this plugin relies on would not hold. Pi
        // sends the same value for the same reason.
        ownership_mode: 'project_owned',
      },
    })
  }

  /**
   * Replace the key, and mark the row unconfirmed.
   *
   * Clearing `registered` first is what makes the caller's failure path honest:
   * if the replacement attempt then fails, the previous answer describes a key
   * this session can no longer use, so it must not be returned as success.
   *
   * @param state - the session whose key is dead.
   * @param reason - the Engram code or row state that killed it, for the log.
   */
  function rotate(state: SessionState, reason: string): void {
    deps.logger.warn(`engram: session ${state.engramSessionId} cannot be reused (${reason}); starting a fresh Engram session`)
    state.engramSessionId = randomUUID()
    state.registered = false
  }

  /**
   * Register or renew, replacing the key when Engram says it is unusable.
   *
   * @param state - the session to register.
   * @param project - its resolved project.
   */
  async function registerWithRotation(state: SessionState, project: string): Promise<void> {
    if (await rowHasEnded(deps.client, state.engramSessionId)) {
      rotate(state, 'the row had already ended')
    }
    try {
      await postSession(state, project)
    } catch (error: unknown) {
      const code = rotationCode(error)
      if (code === undefined) throw error
      rotate(state, code)
      // One retry only: a fresh random key cannot itself be an already-ended
      // row, so a second 409 means the server refuses this session for a reason
      // rotation does not fix, and the caller must see that failure.
      await postSession(state, project)
    }
  }

  /**
   * Run one registration, sharing an in-flight attempt between callers.
   *
   * @param state - the session to register.
   * @param project - its resolved project.
   */
  function registerSession(state: SessionState, project: string): Promise<void> {
    state.registration ??= (async () => {
      // A released incarnation must not mint a row. Its agent was disposed, and
      // a resume is a different state object for the same id, so this cannot
      // block the incarnation that took over.
      if (state.released) return
      await registerWithRotation(state, project)
      state.registered = true
      state.registeredAt = Date.now()
    })().finally(() => {
      state.registration = undefined
    })
    return state.registration
  }

  return {
    async ensureRegistered(state: SessionState, project: string | undefined): Promise<boolean> {
      const confirmed = state.registered
      if (confirmed && Date.now() - state.registeredAt < REGISTRATION_TTL_MS) return true
      if (project === undefined) return false
      try {
        await registerSession(state, project)
      } catch (error: unknown) {
        deps.logger.warn(`engram: session registration failed: ${error instanceof Error ? error.message : String(error)}`)
        // A failed *re*-verification must not break a session that was working:
        // keep the previous answer and let the write itself report a row that is
        // really gone. A rotation clears `registered` first, so a failed
        // replacement reports failure instead of blessing the dead key.
        return confirmed && state.registered
      }
      return state.registered
    },
  }
}
