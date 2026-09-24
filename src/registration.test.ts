import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EngramClient, EngramFetchResult, FetchOptions } from './engram/client.ts'
import { EngramHttpError } from './engram/errors.ts'
import { createRegistration, REGISTRATION_TTL_MS } from './registration.ts'
import { createSessionRegistry, type SessionAgent, type SessionRegistry, type SessionState } from './session.ts'

/**
 * Registration is the one place that decides whether an Engram session key
 * survives. Engram's create route is create-or-renew, and a key is only
 * unusable when the row says so — `ended_at` on the row, or a 409
 * (`session_already_ended` because `ended_at` is terminal and has no un-end
 * route, `session_project_conflict` because a `project_owned` row is pinned to
 * its project). These cases drive the real state machine with only the HTTP
 * boundary stubbed.
 */

const AGENT: SessionAgent = { id: 'session-a', session: { header: { cwd: '/repo' } } }

/** How the stubbed `GET /sessions/{id}` answers. */
type RowState = 'open' | 'ended' | 'missing'

interface Wire {
  readonly calls: string[]
  readonly bodies: Record<string, unknown>[]
}

interface Harness {
  readonly registration: ReturnType<typeof createRegistration>
  readonly sessions: SessionRegistry
  readonly state: SessionState
  readonly wire: Wire
  /** What the next `GET /sessions/{id}` reports. */
  row: RowState
  /** Make every later `POST /sessions` fail. */
  fail: (error: unknown) => void
  /** Make only the next `POST /sessions` fail, so a retry can succeed. */
  failOnce: (error: unknown) => void
  readonly warnings: string[]
}

/** The ids of every `POST /sessions`, in order. */
function postedIds(h: Harness): unknown[] {
  return h.wire.bodies.map(body => body.id)
}

function harness(): Harness {
  const wire: Wire = { calls: [], bodies: [] }
  const warnings: string[] = []
  const queued: unknown[] = []
  let permanent: unknown

  const client: EngramClient = {
    baseUrl: 'http://127.0.0.1:7437',
    request: async <T>(path: string, options?: FetchOptions): Promise<T | null> => {
      const method = options?.method ?? 'GET'
      wire.calls.push(`${method} ${path}`)
      if (method === 'GET') {
        if (self.row === 'missing') throw new EngramHttpError('session not found', 404, { error: 'session not found' })
        return (self.row === 'ended' ? { id: 'session-a', ended_at: '2026-01-01 00:00:00' } : { id: 'session-a' }) as T
      }
      assert.equal(path, '/sessions')
      const body = options?.body as Record<string, unknown>
      wire.bodies.push(body)
      if (queued.length > 0) throw queued.shift()
      if (permanent !== undefined) throw permanent
      return null
    },
    requestResult: async <T>(): Promise<EngramFetchResult<T>> => ({ data: null }),
    bestEffort: async () => null,
    probeHealth: async () => 'ready' as const,
    setRecovery: () => {},
  }

  const sessions = createSessionRegistry({
    info() {},
    warn(message: string) { warnings.push(message) },
  })

  const self: Harness = {
    registration: createRegistration({
      client,
      logger: {
        info() {},
        warn(message: string) { warnings.push(message) },
      },
    }),
    sessions,
    state: sessions.ensure(AGENT),
    wire,
    row: 'open',
    fail: (error: unknown) => { permanent = error },
    failOnce: (error: unknown) => { queued.push(error) },
    warnings,
  }
  return self
}

/** Expire the registration TTL without waiting a minute. */
function ageRegistration(state: SessionState): void {
  state.registeredAt = Date.now() - REGISTRATION_TTL_MS - 1
}

function http409(code: string): EngramHttpError {
  return new EngramHttpError('conflict', 409, { code, error: code, session_id: 'session-a' })
}

test('a first registration posts the agent id as the session key', async () => {
  const h = harness()
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.deepEqual(postedIds(h), ['session-a'])
  assert.deepEqual(h.wire.bodies[0], {
    id: 'session-a',
    project: 'demo',
    directory: '/repo',
    ownership_mode: 'project_owned',
  })
  assert.equal(h.state.registered, true)
})

test('a renewal inside the TTL reuses the key without another request', async () => {
  const h = harness()
  await h.registration.ensureRegistered(h.state, 'demo')
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.deepEqual(h.wire.calls, ['GET /sessions/session-a', 'POST /sessions'])
})

test('renewal after the TTL reuses the same key so a session keeps its binding', async () => {
  const h = harness()
  await h.registration.ensureRegistered(h.state, 'demo')
  ageRegistration(h.state)
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.deepEqual(postedIds(h), ['session-a', 'session-a'])
  assert.equal(h.state.engramSessionId, 'session-a')
})

test('a disposed session resumed under the same agent id reuses its row', async () => {
  const h = harness()
  await h.registration.ensureRegistered(h.state, 'demo')
  // Disposal: release the state and drop it. The Engram row is left open.
  h.state.released = true
  h.sessions.forget(AGENT.id)
  const resumed = h.sessions.ensure(AGENT)
  assert.notEqual(resumed, h.state)
  ageRegistration(resumed)
  assert.equal(await h.registration.ensureRegistered(resumed, 'demo'), true)
  assert.deepEqual(postedIds(h), ['session-a', 'session-a'])
  assert.equal(resumed.engramSessionId, 'session-a')
})

test('a released state never registers, even after a resume re-armed the id', async () => {
  const h = harness()
  h.state.released = true
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), false)
  assert.deepEqual(h.wire.bodies, [])
  assert.equal(h.state.registered, false)
})

test('an ended row rotates the key without posting the dead one', async () => {
  const h = harness()
  h.row = 'ended'
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.equal(h.wire.bodies.length, 1)
  assert.notEqual(h.wire.bodies[0]?.id, 'session-a')
  assert.match(h.warnings.join('\n'), /already ended/)
})

test('an ended row is detected even where POST would answer 201 (Engram < 2.1)', async () => {
  const h = harness()
  // Older servers accept the create and leave `ended_at` set, so the read is
  // the only signal that the key is dead.
  h.row = 'ended'
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  const rotated = h.wire.bodies[0]?.id
  assert.notEqual(rotated, 'session-a')
  assert.equal(h.state.engramSessionId, rotated)
})

test('a deleted row is re-created under the same key', async () => {
  const h = harness()
  h.row = 'missing'
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.deepEqual(postedIds(h), ['session-a'])
})

test('a 409 session_already_ended rotates the key and retries exactly once', async () => {
  const h = harness()
  h.failOnce(http409('session_already_ended'))
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.equal(h.wire.bodies.length, 2)
  assert.notEqual(h.wire.bodies[1]?.id, 'session-a')
  assert.equal(h.state.engramSessionId, h.wire.bodies[1]?.id)
  assert.match(h.warnings.join('\n'), /session_already_ended/)
})

test('a project conflict rotates the key so the new project owns the row', async () => {
  const h = harness()
  h.failOnce(http409('session_project_conflict'))
  assert.equal(await h.registration.ensureRegistered(h.state, 'other'), true)
  assert.equal(h.wire.bodies.length, 2)
  assert.notEqual(h.wire.bodies[1]?.id, 'session-a')
  assert.equal(h.wire.bodies[1]?.project, 'other')
})

test('the rotated key is reused by every later renewal', async () => {
  const h = harness()
  h.failOnce(http409('session_already_ended'))
  await h.registration.ensureRegistered(h.state, 'demo')
  const rotated = h.state.engramSessionId
  ageRegistration(h.state)
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.deepEqual(postedIds(h), ['session-a', rotated, rotated])
})

test('a second 409 on the fresh key is reported instead of rotating again', async () => {
  const h = harness()
  h.fail(http409('session_already_ended'))
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), false)
  assert.equal(h.wire.bodies.length, 2)
  assert.equal(h.state.registered, false)
})

test('a failed retry after a rotation reports failure instead of blessing the dead key', async () => {
  const h = harness()
  await h.registration.ensureRegistered(h.state, 'demo')
  ageRegistration(h.state)
  // The old key is dead, and the replacement never reached the server, so the
  // previous success describes a key this session can no longer use.
  h.failOnce(http409('session_already_ended'))
  h.fail(new EngramHttpError('boom', 500, { error: 'boom' }))
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), false)
  assert.notEqual(h.state.engramSessionId, 'session-a')
  assert.equal(h.state.registered, false)
})

test('a transient failure never rotates the key and keeps the previous answer', async () => {
  const h = harness()
  await h.registration.ensureRegistered(h.state, 'demo')
  h.fail(new EngramHttpError('boom', 500, { error: 'boom' }))
  ageRegistration(h.state)
  // The session was already working, so a failed re-verification keeps it.
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.equal(h.state.engramSessionId, 'session-a')
  assert.deepEqual(postedIds(h), ['session-a', 'session-a'])
})

test('a read failure during re-verification is transient too', async () => {
  const h = harness()
  await h.registration.ensureRegistered(h.state, 'demo')
  ageRegistration(h.state)
  h.row = 'missing'
  h.fail(new Error('socket hang up'))
  // The GET succeeds (404 re-creates), so the POST failure is what is judged.
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), true)
  assert.equal(h.state.engramSessionId, 'session-a')
})

test('a transient failure on a first registration reports failure', async () => {
  const h = harness()
  h.fail(new EngramHttpError('boom', 500, { error: 'boom' }))
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), false)
  assert.equal(h.state.registered, false)
})

test('a non-Engram failure is transient too', async () => {
  const h = harness()
  h.fail(new Error('socket hang up'))
  assert.equal(await h.registration.ensureRegistered(h.state, 'demo'), false)
  assert.equal(h.state.engramSessionId, 'session-a')
})

test('an unresolved project is never posted', async () => {
  const h = harness()
  assert.equal(await h.registration.ensureRegistered(h.state, undefined), false)
  assert.deepEqual(h.wire.calls, [])
})

test('concurrent callers share one in-flight registration', async () => {
  const h = harness()
  await Promise.all([
    h.registration.ensureRegistered(h.state, 'demo'),
    h.registration.ensureRegistered(h.state, 'demo'),
  ])
  assert.deepEqual(postedIds(h), ['session-a'])
})
