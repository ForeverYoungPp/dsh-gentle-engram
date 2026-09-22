import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig, type RawEngramConfig } from '../config.ts'
import { createClient, type EngramClient } from './client.ts'

/**
 * The write path is the part that must never be replayed blindly: a timed-out
 * POST may already have been applied server-side, so its error has to tell the
 * caller to verify before retrying. A timed-out GET carries no such risk and
 * keeps a plain timeout message.
 */

const logger = { info() {}, warn() {} }

/** A well-formed 32-hex instance id. The transport cases below are decided before it is compared. */
const EXPECTED_INSTANCE_ID = '0123456789abcdef0123456789abcdef'

/** Install a fetch that always rejects with Node's timeout error. */
function stubTimedOutFetch(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch
  let calls = 0
  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  globalThis.fetch = (async () => {
    calls += 1
    throw timeout
  }) as typeof fetch
  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = original },
  }
}

/** One fetch call as the stub observed it. */
interface StubCall {
  readonly url: string
  readonly init: RequestInit | undefined
  readonly at: number
}

/**
 * Install a recording fetch. The responder decides each answer and may throw
 * to simulate a transport failure; every call is retained for assertions.
 */
function stubFetch(respond: (call: StubCall, index: number) => Response): { calls: StubCall[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: StubCall[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: StubCall = { url: String(input), init, at: Date.now() }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof fetch
  return {
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

/** A connection-refused transport failure as Node reports it. */
function refusedError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7437'), { code: 'ECONNREFUSED' })
}

function client(raw?: RawEngramConfig): EngramClient {
  return createClient(resolveConfig(raw, () => {}), logger)
}

test('a timed-out write says it may already have landed and must be verified before retrying', async () => {
  const stub = stubTimedOutFetch()
  try {
    await assert.rejects(
      () => client().request('/observations', { method: 'POST', body: { content: 'x' } }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /may already have been applied/)
        assert.match(error.message, /verify with mem_search or mem_doctor/i)
        assert.match(error.message, /do not blindly retry/i)
        return true
      },
    )
    // The retry policy is unchanged: a timeout is reported, never replayed.
    assert.equal(stub.calls(), 1)
  } finally {
    stub.restore()
  }
})

test('a timed-out read keeps a plain timeout message', async () => {
  const stub = stubTimedOutFetch()
  try {
    await assert.rejects(
      () => client().request('/search?q=x'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Engram GET /search?q=x timed out after 3000ms')
        assert.doesNotMatch(error.message, /may already have been applied/)
        return true
      },
    )
    assert.equal(stub.calls(), 1)
  } finally {
    stub.restore()
  }
})

// --- Replay policy ----------------------------------------------------------

test('a refused read is replayed up to fetchMaxAttempts with the documented 250ms base spacing', async () => {
  const stub = stubFetch(() => { throw refusedError() })
  try {
    await assert.rejects(
      () => client({ fetchMaxAttempts: 2 }).request('/search?q=x'),
      /ECONNREFUSED/,
    )
    assert.equal(stub.calls.length, 2)
    const gap = stub.calls[1].at - stub.calls[0].at
    assert.ok(gap >= 240, `expected at least the 250ms backoff base between replays, saw ${gap}ms`)
  } finally {
    stub.restore()
  }
})

test('a refused POST /sessions is replayed because session creation is idempotent', async () => {
  const stub = stubFetch(() => { throw refusedError() })
  try {
    await assert.rejects(
      () => client({ fetchMaxAttempts: 2 }).request('/sessions', { method: 'POST', body: { id: 's', project: 'p' } }),
      /ECONNREFUSED/,
    )
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test('a refused POST /observations is never replayed and propagates unchanged', async () => {
  const refused = refusedError()
  const stub = stubFetch(() => { throw refused })
  try {
    await assert.rejects(
      () => client({ fetchMaxAttempts: 2 }).request('/observations', { method: 'POST', body: { content: 'x' } }),
      (error: unknown) => error === refused,
    )
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('a timed-out GET resolves requestResult with timedOutMethod GET after exactly one attempt', async () => {
  const stub = stubTimedOutFetch()
  try {
    assert.deepEqual(await client().requestResult('/search?q=x'), { data: null, timedOutMethod: 'GET' })
    assert.equal(stub.calls(), 1)
  } finally {
    stub.restore()
  }
})

test('a timed-out POST resolves requestResult with timedOutMethod POST after exactly one attempt', async () => {
  const stub = stubTimedOutFetch()
  try {
    assert.deepEqual(
      await client().requestResult('/observations', { method: 'POST', body: { content: 'x' } }),
      { data: null, timedOutMethod: 'POST' },
    )
    assert.equal(stub.calls(), 1)
  } finally {
    stub.restore()
  }
})

// --- Recovery hook ----------------------------------------------------------

test('a refused connection is healed by the recovery hook on the same attempt slot', async () => {
  const refused = refusedError()
  let fetches = 0
  const stub = stubFetch(() => {
    fetches += 1
    if (fetches === 1) throw refused
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  try {
    let recoveries = 0
    const eng = client({ fetchMaxAttempts: 1 })
    eng.setRecovery(async () => { recoveries += 1; return true })
    assert.deepEqual(await eng.request<{ ok: boolean }>('/search?q=x'), { ok: true })
    // Both calls fit in the single attempt slot: recovery reuses the slot instead
    // of consuming it, so a budget-consuming retry would have thrown here.
    assert.equal(fetches, 2)
    assert.equal(recoveries, 1)
  } finally {
    stub.restore()
  }
})

test('the recovery hook runs at most once even when further attempts are refused', async () => {
  const refused = refusedError()
  const stub = stubFetch(() => { throw refused })
  try {
    let recoveries = 0
    const eng = client({ fetchMaxAttempts: 2 })
    eng.setRecovery(async () => { recoveries += 1; return true })
    await assert.rejects(() => eng.request('/search?q=x'), (error: unknown) => error === refused)
    // The heal reuses the first slot, then the remaining replay attempt still
    // runs; the hook must not fire again for either of them.
    assert.equal(recoveries, 1)
    assert.equal(stub.calls.length, 3)
  } finally {
    stub.restore()
  }
})

test('without a recovery hook the refused error propagates unchanged', async () => {
  const refused = refusedError()
  const stub = stubFetch(() => { throw refused })
  try {
    await assert.rejects(
      () => client({ fetchMaxAttempts: 2 }).request('/search?q=x'),
      (error: unknown) => error === refused,
    )
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

// --- Redaction on the wire --------------------------------------------------

test('the body fetch receives has <private> blocks redacted recursively', async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ id: 1 }), { status: 200 }))
  try {
    await client().request('/observations', {
      method: 'POST',
      body: {
        content: 'before <private>token</private> after',
        nested: { note: '<private>secret</private>' },
        tags: ['kept', '<private>hidden</private>'],
      },
    })
    const raw = stub.calls[0].init?.body
    assert.ok(typeof raw === 'string')
    assert.deepEqual(JSON.parse(raw), {
      content: 'before [REDACTED] after',
      nested: { note: '[REDACTED]' },
      tags: ['kept', '[REDACTED]'],
    })
  } finally {
    stub.restore()
  }
})

test('a private query value reaches fetch redacted while the URL shape is preserved', async () => {
  const stub = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    await client().request('/search?q=hello%20<private>secret</private>&limit=10')
    const requested = new URL(stub.calls[0].url)
    assert.equal(requested.pathname, '/search')
    assert.equal(requested.searchParams.get('q'), 'hello [REDACTED]')
    assert.equal(requested.searchParams.get('limit'), '10')
    assert.ok(!stub.calls[0].url.includes('secret'))
  } finally {
    stub.restore()
  }
})

// --- Lossless JSON on the transport funnel ----------------------------------

test('a server payload carrying a negative zero reaches the caller normalized', async () => {
  const stub = stubFetch(() => new Response('{"rank":-0,"rows":[{"rank":-0},{"rank":0}]}', { status: 200 }))
  try {
    const result = await client().request<{ rank: number; rows: { rank: number }[] }>('/search?q=negative-zero')
    assert.ok(result !== null)
    assert.equal(Object.is(result.rank, -0), false, 'the funnel must remove the -0 the host rejects')
    assert.equal(Object.is(result.rank, 0), true)
    assert.equal(Object.is(result.rows[0].rank, 0), true)
    assert.equal(Object.is(result.rows[1].rank, 0), true)
  } finally {
    stub.restore()
  }
})

// --- probeHealth error mapping ----------------------------------------------
// The ready/foreign mapping is pinned in server.test.ts through ensure(); the
// transport failures are the subject here.

test('probeHealth maps a non-ok response to indeterminate', async () => {
  const stub = stubFetch(() => new Response('down', { status: 503 }))
  try {
    assert.equal(await client().probeHealth(EXPECTED_INSTANCE_ID), 'indeterminate')
  } finally {
    stub.restore()
  }
})

test('probeHealth maps a timeout to indeterminate', async () => {
  const stub = stubTimedOutFetch()
  try {
    assert.equal(await client().probeHealth(EXPECTED_INSTANCE_ID), 'indeterminate')
  } finally {
    stub.restore()
  }
})

test('probeHealth maps a refused connection to refused', async () => {
  const stub = stubFetch(() => { throw refusedError() })
  try {
    assert.equal(await client().probeHealth(EXPECTED_INSTANCE_ID), 'refused')
  } finally {
    stub.restore()
  }
})

test('probeHealth maps an unrecognized transport failure to indeterminate', async () => {
  const stub = stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND engram.invalid') })
  try {
    assert.equal(await client().probeHealth(EXPECTED_INSTANCE_ID), 'indeterminate')
  } finally {
    stub.restore()
  }
})
