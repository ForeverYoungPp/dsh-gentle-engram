/**
 * HTTP client for the Engram server.
 *
 * Behaviour is ported from the upstream Pi adapter because its retry policy is
 * the part most likely to corrupt data if improvised:
 *
 * - Only reads and session registration may be replayed. A timeout means the
 *   request may already have reached the server, and `mem_save`-style writes
 *   carry no idempotency key, so re-sending one could duplicate a memory.
 * - A timed-out write is reported as `{ data: null, timedOutMethod }` so the
 *   caller can tell the user to verify instead of blindly retrying.
 * - Every outgoing body and query value is redacted.
 *
 * @module dsh-gentle-engram/engram/client
 */

import { setTimeout as sleep } from 'node:timers/promises'
import type { EngramConfig } from '../config.ts'
import { redactUrlPath, redactValue } from '../redaction.ts'
import {
  EngramHttpError,
  EngramTimeoutError,
  isConnectionRefusedError,
  isTimeoutError,
} from './errors.ts'

/** Minimal logger seam; Cordis' logger satisfies it. */
export interface Logger {
  warn(message: string): void
  info(message: string): void
}

/** One request's options. */
export interface FetchOptions {
  readonly method?: string
  readonly body?: unknown
  /** Caller cancellation, fused with the timeout. */
  readonly signal?: AbortSignal
}

/** Outcome of one request that distinguishes "unknown" from "failed". */
export interface EngramFetchResult<T> {
  readonly data: T | null
  /** Set when the request timed out; the method names what may have landed. */
  readonly timedOutMethod?: string
}

/** Server reachability as established by a health probe. */
export type EngramHealth = 'ready' | 'refused' | 'indeterminate'

/** The transport surface the rest of the plugin uses. */
export interface EngramClient {
  readonly baseUrl: string
  /** Strict request: throws on any failure. */
  request<T>(path: string, options?: FetchOptions): Promise<T | null>
  /** Request that reports timeouts as data rather than as an exception. */
  requestResult<T>(path: string, options?: FetchOptions): Promise<EngramFetchResult<T>>
  /** Background request: never throws, always logs. */
  bestEffort<T>(path: string, options?: FetchOptions): Promise<T | null>
  /** Fast reachability probe. */
  probeHealth(): Promise<EngramHealth>
  /** Install the one-generation recovery hook used after a refused connection. */
  setRecovery(recovery: (() => Promise<boolean>) | undefined): void
}

const HEALTH_TIMEOUT_MS = 500

/**
 * Whether replaying this request is safe. `POST /sessions` is included because
 * Engram documents session creation as idempotent (INSERT OR IGNORE); every
 * other write has no idempotency key.
 */
export function isSafeToReplay(path: string, method: string): boolean {
  return method === 'GET' || (method === 'POST' && path === '/sessions')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the transport for one resolved configuration.
 *
 * @param config - resolved plugin configuration.
 * @param logger - diagnostic sink; every background failure is reported here.
 */
export function createClient(config: EngramConfig, logger: Logger): EngramClient {
  const baseUrl = config.url ?? `http://127.0.0.1:${config.port}`
  let recovery: (() => Promise<boolean>) | undefined

  async function attempt(path: string, options: FetchOptions): Promise<{ response: Response } | { failure: unknown }> {
    const method = options.method ?? 'GET'
    const timeout = AbortSignal.timeout(config.requestTimeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    try {
      const response = await fetch(`${baseUrl}${redactUrlPath(path)}`, {
        method,
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(redactValue(options.body)),
        signal,
      })
      return { response }
    } catch (error: unknown) {
      return { failure: error }
    }
  }

  /** Decode a completed response, preserving a JSON `null` as success. */
  async function decode<T>(response: Response): Promise<T | null> {
    let data: unknown = null
    if (response.status !== 204) {
      try {
        data = await response.json()
      } catch (error: unknown) {
        if (response.ok) throw error
      }
    }
    if (!response.ok) {
      const record = data !== null && typeof data === 'object' ? data as Record<string, unknown> : undefined
      const detail = typeof record?.error === 'string' ? record.error : `Engram request failed with HTTP ${response.status}`
      throw new EngramHttpError(detail, response.status, data)
    }
    return data as T | null
  }

  async function requestResult<T>(path: string, options: FetchOptions = {}): Promise<EngramFetchResult<T>> {
    const method = options.method ?? 'GET'
    let recovered = false
    for (let attemptIndex = 0; attemptIndex < config.fetchMaxAttempts; attemptIndex += 1) {
      const outcome = await attempt(path, options)
      if ('response' in outcome) return { data: await decode<T>(outcome.response) }

      const error = outcome.failure
      // A timeout may already have applied server-side; never replay it.
      if (isTimeoutError(error)) return { data: null, timedOutMethod: method }

      // A refused connection proves the request never reached the server, so
      // even a write with no idempotency key may be replayed — and must be.
      // Reporting it as an empty success told every caller that a memory which
      // was never sent had been stored, which is how a compaction archive could
      // claim "already saved" for a summary it had dropped on the floor.
      if (isConnectionRefusedError(error) && !recovered && await recoverOnce()) {
        recovered = true
        // Retry on the same attempt slot: the attempt budget is for transport
        // flakiness, not for bringing the server back.
        attemptIndex -= 1
        continue
      }
      if (!isSafeToReplay(path, method) || attemptIndex === config.fetchMaxAttempts - 1) {
        throw error
      }
      await sleep(250 * 2 ** attemptIndex, undefined, { ref: false })
    }
    throw new EngramTimeoutError(`Engram request to ${redactUrlPath(path)} exhausted its attempts`)
  }

  let recoveryInFlight: Promise<boolean> | undefined
  async function recoverOnce(): Promise<boolean> {
    if (recovery === undefined) return false
    recoveryInFlight ??= recovery().finally(() => { recoveryInFlight = undefined })
    return recoveryInFlight
  }

  return {
    baseUrl,
    async request<T>(path: string, options?: FetchOptions): Promise<T | null> {
      const result = await requestResult<T>(path, options)
      if (result.timedOutMethod !== undefined) {
        throw new EngramTimeoutError(`Engram ${result.timedOutMethod} ${redactUrlPath(path)} timed out after ${config.requestTimeoutMs}ms`)
      }
      return result.data
    },
    requestResult,
    async bestEffort<T>(path: string, options?: FetchOptions): Promise<T | null> {
      try {
        return await this.request<T>(path, options)
      } catch (error: unknown) {
        // Background capture must never be silent: a user whose memories
        // stopped being saved deserves a signal.
        logger.warn(`engram background capture to ${redactUrlPath(path)} failed: ${messageOf(error)}`)
        return null
      }
    },
    async probeHealth(): Promise<EngramHealth> {
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        return response.ok ? 'ready' : 'indeterminate'
      } catch (error: unknown) {
        if (isTimeoutError(error)) return 'indeterminate'
        if (isConnectionRefusedError(error)) return 'refused'
        return 'indeterminate'
      }
    },
    setRecovery(next: (() => Promise<boolean>) | undefined): void {
      recovery = next
    },
  }
}
