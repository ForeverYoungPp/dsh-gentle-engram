/**
 * Lifecycle for an implicitly owned `engram serve` child process.
 *
 * The logic is ported from the upstream Pi adapter's `initializeEngramServer`
 * rather than from DSH's own MCP connection supervisor. That distinction is
 * deliberate: `dsh-mcp-client`'s supervisor exists because a stdio server is a
 * stateful long-lived connection whose death is an observable event and whose
 * registered tools all break at once. Here there is no persistent connection
 * to lose — failures are observed request by request and the server may be
 * externally owned. What transfers from that supervisor is only discipline:
 *
 * - one generation owns recovery, so a restart storm is impossible;
 * - backoff timers are unref'd and never hold the host process open;
 * - a child we gave up on is killed, not merely unreferenced — otherwise every
 *   retry would add another detached, non-answering process;
 * - a failed startup stays retryable, but inside the backoff window callers
 *   get the previous failure immediately instead of re-paying the full
 *   readiness budget on every tool call.
 *
 * @module dsh-gentle-engram/engram/server
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { EngramConfig } from '../config.ts'
import type { EngramClient, Logger } from './client.ts'

/** Owns the implicit server's startup and bounded recovery. */
export interface ServerManager {
  /** Ensure a server is answering, spawning one if needed and allowed. */
  ensure(): Promise<void>
}

const STARTUP_POLL_MS = 100
const STARTUP_RETRY_BASE_MS = 1000
const STARTUP_RETRY_MAX_MS = 60_000

/** A sleep an abandoned readiness wait can cut short. */
async function waitCancellable(ms: number, signal: AbortSignal): Promise<void> {
  // timers/promises rejects on abort; the caller re-checks the signal afterwards,
  // so an abort is an early wake rather than a failure.
  try {
    await sleep(ms, undefined, { signal })
  } catch {
    // ignored on purpose
  }
}

/**
 * A child we gave up on is terminated, not merely released. Unref'ing alone
 * only detaches it from our event loop: the process stays alive, detached,
 * answering nothing — and because startup is retried, every later attempt
 * would add another one for the life of the host.
 */
function stopAbandonedChild(child: ChildProcess | undefined): void {
  if (child === undefined) return
  try {
    child.kill('SIGTERM')
  } catch {
    // Best effort: on the exit path the child is already gone.
  }
  child.unref()
}

/**
 * Create the startup owner for one resolved configuration.
 *
 * @param config - resolved plugin configuration.
 * @param client - transport used for health probes.
 * @param logger - diagnostic sink.
 */
export function createServerManager(config: EngramConfig, client: EngramClient, logger: Logger): ServerManager {
  let initialization: Promise<void> | undefined
  let startupFailures = 0
  let startupRetryAt = 0
  let startupFailure: Error | undefined
  let initializationGeneration = 0
  let recoveredGeneration = 0
  let recoveryFlight: { generation: number; promise: Promise<boolean> } | undefined

  function startupBackoffMs(failures: number): number {
    return Math.min(STARTUP_RETRY_MAX_MS, STARTUP_RETRY_BASE_MS * 2 ** (failures - 1))
  }

  async function waitForReadiness(signal: AbortSignal, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error(`Engram readiness wait for ${client.baseUrl} was cancelled`)
      if (await client.probeHealth() === 'ready') return
      // The probe can outlive the abort, so re-check before sleeping again.
      if (signal.aborted) throw new Error(`Engram readiness wait for ${client.baseUrl} was cancelled`)
      await waitCancellable(STARTUP_POLL_MS, signal)
    }
    throw new Error(`Engram server at ${client.baseUrl} did not become ready before the startup timeout`)
  }

  function spawnAndWait(deadline: number): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      let child: ChildProcess | undefined
      let settled = false
      // One controller cancels the poll from every terminal path, so a child
      // that errors, exits, or never becomes ready cannot leave a probe loop
      // running behind it.
      const readiness = new AbortController()

      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        readiness.abort()
        child?.removeListener('error', onError)
        child?.removeListener('exit', onExit)
        if (error !== undefined) {
          stopAbandonedChild(child)
          rejectPromise(error)
          return
        }
        child?.unref()
        resolvePromise()
      }

      const onError = (error: Error): void =>
        settle(new Error(`Engram server failed before readiness: ${error.message}`))
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        settle(new Error(`Engram server exited before readiness (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`))

      try {
        child = spawn(config.binary, ['serve'], { windowsHide: true, detached: true, stdio: 'ignore' })
      } catch (error: unknown) {
        settle(error instanceof Error ? error : new Error('Engram server could not start'))
        return
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.once('spawn', () => {
        void waitForReadiness(readiness.signal, deadline).then(
          () => settle(),
          (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))),
        )
      })
    })
  }

  async function initialize(): Promise<void> {
    if (config.url !== undefined) return
    const deadline = Date.now() + config.startupTimeoutMs
    const health = await client.probeHealth()
    if (health === 'ready') return

    // Only "ready" proves a server is answering. Every other outcome — a
    // definitive refusal, an aborted probe, a DNS failure, an error shape we do
    // not recognise — means we have no server, so launch one. Reading an
    // inconclusive probe as "a server must be starting" is what lets a cold
    // machine burn the whole budget polling a port nobody will bind.
    try {
      await spawnAndWait(deadline)
    } catch (error: unknown) {
      // An inconclusive probe leaves room for another process to already own
      // the port, which is exactly what makes our child fail. Give that
      // instance the rest of the shared deadline before reporting failure.
      if (health !== 'indeterminate') throw error
      const readiness = new AbortController()
      try {
        await waitForReadiness(readiness.signal, deadline)
      } catch {
        // The spawn failure is the actionable one; a readiness timeout only restates it.
        throw error
      } finally {
        readiness.abort()
      }
    }
  }

  /**
   * A failed startup stays retryable, but inside the backoff window the last
   * failure is replayed immediately: an unhealthy provider then costs one
   * backoff window rather than one full readiness budget per tool call, and a
   * failing session cannot spawn children without bound.
   */
  function sharedInitialization(): Promise<void> {
    if (initialization !== undefined) return initialization
    if (startupFailure !== undefined && Date.now() < startupRetryAt) return Promise.reject(startupFailure)
    initialization = initialize().then(
      () => {
        startupFailures = 0
        startupRetryAt = 0
        startupFailure = undefined
        initializationGeneration += 1
      },
      (error: unknown) => {
        initialization = undefined
        startupFailures += 1
        startupFailure = error instanceof Error ? error : new Error(String(error))
        startupRetryAt = Date.now() + startupBackoffMs(startupFailures)
        throw startupFailure
      },
    )
    return initialization
  }

  // Initialization stays fulfilled for the session, so a later refusal needs a
  // separate bounded path. Marking a generation before starting prevents a
  // failed restart from becoming a spawn storm.
  function recover(): Promise<boolean> {
    const generation = initializationGeneration
    if (config.url !== undefined || generation === 0) return Promise.resolve(false)
    const active = recoveryFlight
    if (active?.generation === generation) return active.promise
    if (recoveredGeneration === generation) return Promise.resolve(false)
    recoveredGeneration = generation
    const promise = initialize().then(() => true, () => false).finally(() => {
      if (recoveryFlight?.generation === generation) recoveryFlight = undefined
    })
    recoveryFlight = { generation, promise }
    return promise
  }

  client.setRecovery(recover)

  return {
    async ensure(): Promise<void> {
      try {
        await sharedInitialization()
      } catch (error: unknown) {
        logger.warn(`engram server unavailable at ${client.baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
  }
}
