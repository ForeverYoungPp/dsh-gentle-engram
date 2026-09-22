import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'

import { resolveConfig, type EngramConfig } from '../config.ts'
import { createClient, type Logger } from './client.ts'
import { createServerManager } from './server.ts'

/**
 * The implicitly owned Engram server must be this machine's own instance. The
 * check is strict: a foreign `instance_id`, a health body without one, or an
 * unreadable local id all refuse to attach. `ENGRAM_URL` is the explicit
 * opt-out. Only the HTTP boundary and the `instance-id` subprocess are stubbed;
 * the cases drive `ensure()` exactly as the plugin does.
 */

const LOCAL_INSTANCE_ID = '0123456789abcdef0123456789abcdef'
const FOREIGN_INSTANCE_ID = 'fedcba9876543210fedcba9876543210'

/** A temp directory removed when its test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engram-server-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** An executable `instance-id` stub standing in for the Engram binary. */
function stubBinary(dir: string, script: string): string {
  const path = join(dir, 'instance-id')
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A connection-refused transport failure as Node reports it. */
function refusedError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7437'), { code: 'ECONNREFUSED' })
}

/**
 * A binary stub that records every invocation and answers the instance-id read.
 * The `serve` branch stays alive for a moment so a readiness poll can observe it;
 * the manager kills an abandoned child, and the self-exit only backstops that.
 */
function recordingBinary(dir: string, record: string, serveLifetimeMs: number): string {
  return stubBinary(dir, `
    require('node:fs').appendFileSync(${JSON.stringify(record)}, process.argv[2] + '\\n')
    if (process.argv[2] === 'instance-id') { console.log('${LOCAL_INSTANCE_ID}'); process.exit(0) }
    setTimeout(() => process.exit(0), ${serveLifetimeMs})
  `)
}

/** The recorded invocation log, one command per line. */
function invocations(record: string): string[] {
  if (!existsSync(record)) return []
  return readFileSync(record, 'utf8').split('\n').filter(line => line.length > 0)
}

/** Wait until a condition holds, so a detached child's side effect can be observed. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(20)
  }
  throw new Error('condition was not met before the timeout')
}

/** Stub `globalThis.fetch` with a responder, recording each request URL. */
function stubFetch(t: TestContext, respond: (url: string) => Response): string[] {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input))
    return respond(String(input))
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return calls
}

/** Stub `globalThis.fetch` to answer every request with one JSON body. */
function stubHealthFetch(t: TestContext, body: unknown): string[] {
  return stubFetch(t, () => new Response(JSON.stringify(body), { status: 200 }))
}

function recordingLogger(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info() {},
    warn(message: string) { warnings.push(message) },
  }
}

function configFor(binary: string, url: string | undefined = undefined, overrides: Partial<EngramConfig> = {}): EngramConfig {
  // Spread the resolved config first, then the explicit values, so the ambient
  // environment cannot leak a URL or another binary into a case that must not
  // have one. Overrides last so a case can tighten its own budgets.
  return { ...resolveConfig(undefined, () => {}), binary, url, ...overrides }
}

function ensure(config: EngramConfig, logger: Logger): Promise<void> {
  return createServerManager(config, createClient(config, logger), logger).ensure()
}

test('a matching instance id is accepted with one /health probe and no spawn', async (t) => {
  const dir = tempDir(t)
  const binary = stubBinary(dir, `console.log('${LOCAL_INSTANCE_ID}')`)
  const calls = stubHealthFetch(t, { instance_id: LOCAL_INSTANCE_ID })
  const config = configFor(binary)
  const logger = recordingLogger()

  await ensure(config, logger)

  // "Ready" is a server that is already up, so the one probe is the only
  // request; a spawn would have run the id stub with `serve` and exited before
  // readiness, which would have rejected instead.
  assert.deepEqual(calls, [`http://127.0.0.1:${config.port}/health`])
  assert.deepEqual(logger.warnings, [])
})

test('a server with a different instance id is refused as an ownership mismatch without spawning', async (t) => {
  const dir = tempDir(t)
  const binary = stubBinary(dir, `console.log('${LOCAL_INSTANCE_ID}')`)
  const calls = stubHealthFetch(t, { instance_id: FOREIGN_INSTANCE_ID })
  const config = configFor(binary)
  const logger = recordingLogger()

  await assert.rejects(
    () => ensure(config, logger),
    /ownership mismatch/,
  )
  assert.equal(calls.length, 1)
})

test('a health body without instance_id is refused, not tolerated (strict choice)', async (t) => {
  const dir = tempDir(t)
  const binary = stubBinary(dir, `console.log('${LOCAL_INSTANCE_ID}')`)
  stubHealthFetch(t, { status: 'ok' })
  const config = configFor(binary)
  const logger = recordingLogger()

  await assert.rejects(
    () => ensure(config, logger),
    /ownership mismatch/,
  )
})

test('an unparseable health body is refused like a missing instance_id', async (t) => {
  const dir = tempDir(t)
  const binary = stubBinary(dir, `console.log('${LOCAL_INSTANCE_ID}')`)
  stubFetch(t, () => new Response('not json', { status: 200 }))
  const config = configFor(binary)
  const logger = recordingLogger()

  await assert.rejects(
    () => ensure(config, logger),
    /ownership mismatch/,
  )
})

test('a binary that prints garbage rejects with the ENGRAM_URL opt-out named', async (t) => {
  const dir = tempDir(t)
  const binary = stubBinary(dir, `console.log('not-an-instance-id')`)
  stubHealthFetch(t, { instance_id: LOCAL_INSTANCE_ID })
  const config = configFor(binary)
  const logger = recordingLogger()

  await assert.rejects(
    () => ensure(config, logger),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /could not read this machine's local server identity/)
      assert.match(error.message, /ENGRAM_URL/)
      return true
    },
  )
})

test('a binary that exits non-zero rejects with the ENGRAM_URL opt-out named', async (t) => {
  const dir = tempDir(t)
  const binary = stubBinary(dir, 'process.exit(1)')
  stubHealthFetch(t, { instance_id: LOCAL_INSTANCE_ID })
  const config = configFor(binary)
  const logger = recordingLogger()

  await assert.rejects(
    () => ensure(config, logger),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /could not read this machine's local server identity/)
      assert.match(error.message, /ENGRAM_URL/)
      return true
    },
  )
})

test('an explicitly configured ENGRAM_URL skips the instance-id read entirely', async (t) => {
  const dir = tempDir(t)
  // A nonexistent binary proves no instance-id read is attempted: any read
  // would fail before ensure() could resolve.
  const binary = join(dir, 'does-not-exist')
  stubHealthFetch(t, { status: 'ok' })
  const config = configFor(binary, 'http://127.0.0.1:7599')
  const logger = recordingLogger()

  await ensure(config, logger)
})

// --- Lifecycle discipline ---------------------------------------------------

test('a refused health probe makes ensure() spawn the binary and poll until ready', async (t) => {
  const dir = tempDir(t)
  const record = join(dir, 'invocations.log')
  const binary = recordingBinary(dir, record, 1000)
  let probes = 0
  const calls = stubFetch(t, () => {
    probes += 1
    if (probes === 1) throw refusedError()
    return new Response(JSON.stringify({ instance_id: LOCAL_INSTANCE_ID }), { status: 200 })
  })
  const config = configFor(binary)
  const logger = recordingLogger()

  await ensure(config, logger)
  await waitUntil(() => invocations(record).includes('serve'))

  // One refused initial probe, then one readiness probe after the single spawn.
  assert.equal(calls.length, 2)
  assert.deepEqual(invocations(record), ['instance-id', 'serve'])
})

test('ensure() rejects with the startup-timeout error when the server never becomes ready', async (t) => {
  const dir = tempDir(t)
  const binary = recordingBinary(dir, join(dir, 'invocations.log'), 2000)
  stubFetch(t, () => { throw refusedError() })
  const config = configFor(binary, undefined, { startupTimeoutMs: 800 })
  const logger = recordingLogger()

  await assert.rejects(
    () => ensure(config, logger),
    /did not become ready before the startup timeout/,
  )
})

test('a failed ensure() replays the cached failure without another spawn, then retries after the backoff window', async (t) => {
  const dir = tempDir(t)
  const record = join(dir, 'invocations.log')
  const binary = recordingBinary(dir, record, 2000)
  stubFetch(t, () => { throw refusedError() })
  const config = configFor(binary, undefined, { startupTimeoutMs: 800 })
  const logger = recordingLogger()
  const manager = createServerManager(config, createClient(config, logger), logger)

  const firstError = await manager.ensure().then(
    () => undefined,
    (error: unknown) => error,
  )
  assert.ok(firstError instanceof Error)
  assert.match(firstError.message, /did not become ready before the startup timeout/)
  await waitUntil(() => invocations(record).filter(line => line === 'serve').length === 1)

  // Inside the documented 1000ms base backoff window: cached failure, no spawn.
  await assert.rejects(() => manager.ensure(), (error: unknown) => error === firstError)
  assert.equal(invocations(record).filter(line => line === 'serve').length, 1)

  // Past the window the failed startup stays retryable and spawns again.
  await sleep(1100)
  await assert.rejects(
    () => manager.ensure(),
    (error: unknown) => error !== firstError && error instanceof Error &&
      /did not become ready before the startup timeout/.test(error.message),
  )
  await waitUntil(() => invocations(record).filter(line => line === 'serve').length === 2)
})

test('an explicitly configured URL never spawns a healer for a refused request', async (t) => {
  const dir = tempDir(t)
  const record = join(dir, 'invocations.log')
  const binary = recordingBinary(dir, record, 1000)
  const refused = refusedError()
  stubFetch(t, () => { throw refused })
  const config = configFor(binary, 'http://127.0.0.1:7599', { fetchMaxAttempts: 2 })
  const logger = recordingLogger()
  const client = createClient(config, logger)
  const manager = createServerManager(config, client, logger)

  await manager.ensure()
  await assert.rejects(() => client.request('/search?q=x'), (error: unknown) => error === refused)

  // URL-guarded recovery resolves false before any generation is tracked, so the
  // binary is never invoked: no instance-id read, no spawn, no heal.
  assert.equal(existsSync(record), false)
})
