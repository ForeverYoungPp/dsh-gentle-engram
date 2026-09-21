/**
 * Error shapes for the Engram HTTP transport, plus the classifiers the
 * lifecycle logic needs to tell "nothing is listening" apart from "something
 * answered but is unwell" and from "we do not know".
 *
 * @module dsh-gentle-engram/engram/errors
 */

/** A response arrived with a non-2xx status. */
export class EngramHttpError extends Error {
  readonly status: number
  readonly data: unknown

  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.name = 'EngramHttpError'
    this.status = status
    this.data = data
  }
}

/** A request exceeded its timeout budget; the write may already have landed. */
export class EngramTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngramTimeoutError'
  }
}

/** Node reports an aborted or expired request through these names. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Node reports a refused localhost connection through several shapes: a bare
 * Error whose message is the refusal, a wrapper whose `cause` carries `code`,
 * and — when the host resolves to both ::1 and 127.0.0.1 — an AggregateError
 * whose per-address `errors` carry it while the aggregate itself carries none.
 * Walk all of them, and read `code` through the prototype chain.
 */
export function hasConnectionRefusedCode(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.code === 'ECONNREFUSED') return true
  const errors = record.errors
  if (Array.isArray(errors) && errors.some(entry => hasConnectionRefusedCode(entry, depth + 1))) return true
  return hasConnectionRefusedCode(record.cause, depth + 1)
}

/** Whether a transport failure proves nothing is listening. */
export function isConnectionRefusedError(error: unknown): boolean {
  return (error instanceof Error && error.message === 'connection refused') || hasConnectionRefusedCode(error)
}

/** Engram error codes this plugin reacts to by name. */
export const ERROR_CODE = {
  ambiguousProject: 'ambiguous_project',
  projectOwnershipRequired: 'project_ownership_required',
  sessionAlreadyEnded: 'session_already_ended',
  unknownSession: 'unknown_session',
} as const

/** Read an Engram error code out of an HTTP error body, when present. */
export function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof EngramHttpError)) return undefined
  const data = error.data
  if (data === null || typeof data !== 'object') return undefined
  const code = (data as Record<string, unknown>).error_code ?? (data as Record<string, unknown>).code
  return typeof code === 'string' ? code : undefined
}

/** Read Engram's `available_projects` hint, when present. */
export function availableProjectsOf(error: unknown): string[] {
  if (!(error instanceof EngramHttpError)) return []
  const data = error.data
  if (data === null || typeof data !== 'object') return []
  const list = (data as Record<string, unknown>).available_projects
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
}
