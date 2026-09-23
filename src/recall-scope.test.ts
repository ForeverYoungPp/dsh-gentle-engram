import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { resolveConfig } from './config.ts'
import type { FetchOptions } from './engram/client.ts'
import { EngramHttpError } from './engram/errors.ts'
import { resolveProject } from './engram/project.ts'
import { createSessionRegistry, type SessionState } from './session.ts'
import * as tools from './tools.ts'

/**
 * Every recall request must be attributable to exactly one project. An omitted
 * project is not "no filter": the Engram server resolves it against the serving
 * process's own working directory, which no session owns. These cases drive the
 * real tool definitions with only the HTTP boundary stubbed, and assert on the
 * request path that a call actually produces.
 */

interface Harness {
  readonly definitions: Map<string, ToolDefinition>
  readonly requests: string[]
  readonly methods: string[]
  readonly client: tools.ToolDeps['client']
  readonly state: SessionState
}

/**
 * Build a harness. `headerCwd` defaults to `/repo`; pass `null` for a session
 * whose header reports no working directory at all. `onRequest` replaces the
 * default successful stub, for tests that script the HTTP boundary.
 */
function harness(headerCwd: string | null = '/repo', onRequest?: (path: string) => Promise<unknown>): Harness {
  const requests: string[] = []
  const methods: string[] = []
  const sessions = createSessionRegistry({ info() {}, warn() {} })
  const client: tools.ToolDeps['client'] = {
    baseUrl: 'http://127.0.0.1:7437',
    request: async <T>(path: string, options?: FetchOptions): Promise<T | null> => {
      requests.push(path)
      methods.push(options?.method ?? 'GET')
      if (onRequest !== undefined) return await onRequest(path) as T | null
      return null
    },
    requestResult: async () => ({ data: null }),
    bestEffort: async () => null,
    probeHealth: async () => 'ready' as const,
    setRecovery: () => {},
  }
  const deps: tools.ToolDeps = {
    client,
    sessions,
    logger: { info() {}, warn() {} },
    config: resolveConfig(undefined, () => {}),
    summarize: async () => null,
    startSession: async () => {},
    ensureRegistered: async () => true,
  }
  const definitions = new Map<string, ToolDefinition>()
  tools.registerTools(definition => {
    definitions.set(definition.name, definition)
    return () => {}
  }, deps)
  const agent = { id: 'session-a', session: { header: headerCwd === null ? {} : { cwd: headerCwd } } }
  return { definitions, requests, methods, client, state: sessions.ensure(agent) }
}

/** Invoke one registered definition the way the registry would. */
async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<unknown> {
  const definition = h.definitions.get(name)
  assert.ok(definition !== undefined, `${name} was not registered`)
  const exec = { agent: { id: 'session-a', session: { header: { cwd: '/repo' } } } }
  return definition.execute(args, exec as never)
}

/** The query parameters of one recorded request path. */
function queryOf(path: string): URLSearchParams {
  const index = path.indexOf('?')
  return new URLSearchParams(index === -1 ? '' : path.slice(index + 1))
}

function resolveTo(state: SessionState, project: string): void {
  state.project = { kind: 'resolved', project, source: 'config' }
}

function failResolution(state: SessionState): void {
  state.project = { kind: 'failed', reason: 'ambiguous project', available: ['a', 'b'] }
}

const FAIL_CLOSED = /cannot resolve this workspace's project/
const NO_SESSION_CWD = /did not report a working directory/
const NO_CWD_ARGUMENT = /reported no working directory/

test("mem_search sends the session's resolved project by default", async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_search', { query: 'anything' })
  assert.equal(h.requests.length, 1)
  assert.equal(queryOf(h.requests[0]!).get('project'), 'demo')
})

test("mem_search ignores an explicit project argument and recalls from the session's project", async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_search', { query: 'anything', project: 'other' })
  assert.equal(h.requests.length, 1)
  assert.equal(queryOf(h.requests[0]!).get('project'), 'demo')
})

test('mem_search sends all_projects=true with no project when asked explicitly', async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_search', { query: 'anything', all_projects: true })
  assert.equal(h.requests.length, 1)
  const params = queryOf(h.requests[0]!)
  assert.equal(params.get('all_projects'), 'true')
  assert.equal(params.get('project'), null)
})

test('mem_search fails closed when the project is unresolved and issues no request', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(() => call(h, 'mem_search', { query: 'anything' }), FAIL_CLOSED)
  assert.equal(h.requests.length, 0)
})

test("mem_context ignores an explicit project argument and reads the session's project", async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_context', { project: 'other' })
  assert.equal(h.requests.length, 1)
  assert.equal(queryOf(h.requests[0]!).get('project'), 'demo')
})

test('mem_context fails closed when the project is unresolved and issues no request', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(() => call(h, 'mem_context', {}), FAIL_CLOSED)
  assert.equal(h.requests.length, 0)
})

test("mem_stats sends the session's resolved project by default", async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_stats', {})
  assert.equal(h.requests.length, 1)
  assert.ok(h.requests[0]!.startsWith('/stats?'), `unexpected route: ${h.requests[0]}`)
  const params = queryOf(h.requests[0]!)
  assert.equal(params.get('project'), 'demo')
  assert.equal(params.get('all_projects'), null)
})

test('mem_stats sends all_projects=true with no project when asked explicitly', async () => {
  const h = harness()
  // The widening must work in exactly the workspace where scoped recall cannot:
  // project resolution ambiguous, so no session project is available.
  failResolution(h.state)
  await call(h, 'mem_stats', { all_projects: true })
  assert.equal(h.requests.length, 1)
  const params = queryOf(h.requests[0]!)
  assert.equal(params.get('all_projects'), 'true')
  assert.equal(params.get('project'), null)
})

test('mem_stats fails closed when the project is unresolved and issues no request', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(() => call(h, 'mem_stats', {}), FAIL_CLOSED)
  assert.equal(h.requests.length, 0)
})

test("mem_timeline sends observation_id, before, after and the session's project", async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_timeline', { observation_id: 670, before: 1, after: 2 })
  assert.equal(h.requests.length, 1)
  assert.ok(h.requests[0]!.startsWith('/timeline?'), `unexpected route: ${h.requests[0]}`)
  const params = queryOf(h.requests[0]!)
  assert.equal(params.get('observation_id'), '670')
  assert.equal(params.get('before'), '1')
  assert.equal(params.get('after'), '2')
  assert.equal(params.get('project'), 'demo')
})

test('mem_timeline fails closed when the project is unresolved and issues no request', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(() => call(h, 'mem_timeline', { observation_id: 670 }), FAIL_CLOSED)
  assert.equal(h.requests.length, 0)
})

test('mem_doctor fails closed when the project is unresolved and issues no request', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(() => call(h, 'mem_doctor', {}), FAIL_CLOSED)
  assert.equal(h.requests.length, 0)
})

test('mem_review list fails closed when the project is unresolved and issues no request', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(() => call(h, 'mem_review', { action: 'list' }), FAIL_CLOSED)
  assert.equal(h.requests.length, 0)
})

test("mem_review list still sends the session's project without the widening flag", async () => {
  const h = harness()
  resolveTo(h.state, 'demo')
  await call(h, 'mem_review', { action: 'list', limit: 5 })
  assert.equal(h.requests.length, 1)
  const params = queryOf(h.requests[0]!)
  assert.equal(params.get('project'), 'demo')
  assert.equal(params.get('limit'), '5')
  assert.equal(params.get('all_projects'), null)
})

test('mem_review list widens to all_projects with no project when asked explicitly', async () => {
  const h = harness()
  failResolution(h.state)
  await call(h, 'mem_review', { action: 'list', all_projects: true })
  assert.equal(h.requests.length, 1)
  const params = queryOf(h.requests[0]!)
  assert.equal(params.get('all_projects'), 'true')
  assert.equal(params.get('project'), null)
})

test('mem_review mark_reviewed stays project-required even with all_projects set', async () => {
  const h = harness()
  failResolution(h.state)
  await assert.rejects(
    () => call(h, 'mem_review', { action: 'mark_reviewed', observation_id: 1, all_projects: true }),
    FAIL_CLOSED,
  )
  assert.equal(h.requests.length, 0)
})

test('resolveProject refuses an empty cwd and issues no request', async () => {
  const h = harness()
  const resolution = await resolveProject(h.client, '')
  assert.equal(resolution.kind, 'failed')
  assert.match(resolution.kind === 'failed' ? resolution.reason : '', NO_SESSION_CWD)
  assert.equal(h.requests.length, 0)
})

test('resolveProject refuses a whitespace-only cwd and issues no request', async () => {
  const h = harness()
  const resolution = await resolveProject(h.client, '   ')
  assert.equal(resolution.kind, 'failed')
  assert.equal(h.requests.length, 0)
})

test('resolveProject still queries /project/current for a real cwd', async () => {
  const h = harness()
  await resolveProject(h.client, '/repo with spaces')
  assert.deepEqual(h.requests, ['/project/current?cwd=%2Frepo%20with%20spaces'])
})

test('resolveProject retries a transient failure and resolves once the server answers', async () => {
  let calls = 0
  const h = harness('/repo', async () => {
    calls += 1
    if (calls < 3) throw new Error('server still starting')
    return { project: 'demo', project_source: 'config' }
  })
  const resolution = await resolveProject(h.client, '/repo')
  assert.equal(resolution.kind, 'resolved')
  assert.equal(resolution.kind === 'resolved' ? resolution.project : '', 'demo')
  assert.equal(calls, 3)
})

test('resolveProject gives up after five attempts and still fails closed', async () => {
  let calls = 0
  const h = harness('/repo', async () => {
    calls += 1
    throw new Error('server down')
  })
  const resolution = await resolveProject(h.client, '/repo')
  assert.equal(resolution.kind, 'failed')
  assert.equal(resolution.kind === 'failed' ? resolution.reason : '', 'server down')
  assert.equal(calls, 5)
})

test('resolveProject treats a 404 as unsupported and falls back after one call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-project-'))
  try {
    mkdirSync(join(dir, '.engram'))
    writeFileSync(join(dir, '.engram', 'config.json'), JSON.stringify({ project_name: 'from-config' }))
    let calls = 0
    const h = harness('/repo', async () => {
      calls += 1
      throw new EngramHttpError('not found', 404, null)
    })
    const resolution = await resolveProject(h.client, dir)
    assert.equal(calls, 1)
    assert.equal(resolution.kind, 'resolved')
    assert.equal(resolution.kind === 'resolved' ? resolution.project : '', 'from-config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session with no reported cwd fails closed on the read path and issues no request', async () => {
  const h = harness(null)
  // The warm-up stores exactly what resolveProject returns for the session's cwd.
  h.state.project = await resolveProject(h.client, h.state.cwd)
  await assert.rejects(() => call(h, 'mem_context', {}), NO_SESSION_CWD)
  assert.equal(h.requests.length, 0)
})

test('a cwd-less session reports the missing directory instead of config-file guidance', async () => {
  const h = harness(null)
  // The shape the warm-up stores for a session whose resolution failed because
  // the session named no directory at all.
  h.state.project = { kind: 'failed', reason: 'this session did not report a working directory', available: [] }
  await assert.rejects(() => call(h, 'mem_context', {}), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /working directory/)
    assert.ok(!message.includes('.engram/config.json'), `config guidance leaked into: ${message}`)
    return true
  })
  assert.equal(h.requests.length, 0)
})

test('mem_current_project throws for a session with no reported cwd and issues no request', async () => {
  const h = harness(null)
  await assert.rejects(() => call(h, 'mem_current_project', {}), NO_CWD_ARGUMENT)
  assert.equal(h.requests.length, 0)
})

test('mem_current_project inspects an explicit cwd without a session directory', async () => {
  const h = harness(null)
  await call(h, 'mem_current_project', { cwd: '/elsewhere' })
  assert.deepEqual(h.requests, ['/project/current?cwd=%2Felsewhere'])
})

test('mem_current_project refuses a relative cwd and issues no request', async () => {
  const h = harness()
  await assert.rejects(() => call(h, 'mem_current_project', { cwd: 'sibling/repo' }), /absolute path/)
  assert.equal(h.requests.length, 0)
})

test('mem_delete sends DELETE /observations/<id>?hard=true when hard_delete is true', async () => {
  const h = harness()
  await call(h, 'mem_delete', { id: 42, hard_delete: true })
  assert.deepEqual(h.methods, ['DELETE'])
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0], '/observations/42?hard=true')
})

test('mem_delete sends DELETE /observations/<id> with no query string when hard_delete is omitted', async () => {
  const h = harness()
  await call(h, 'mem_delete', { id: 42 })
  assert.deepEqual(h.methods, ['DELETE'])
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0], '/observations/42')
})

test('mem_delete surfaces a server error instead of reporting a deleted memory', async () => {
  const h = harness('/repo', async () => {
    throw new EngramHttpError('observation not found', 404, { error: 'observation not found' })
  })
  await assert.rejects(() => call(h, 'mem_delete', { id: 999_999_999 }), (error: unknown) => {
    assert.ok(error instanceof EngramHttpError, 'a failed delete must not resolve')
    assert.equal(error.status, 404)
    assert.match(error.message, /observation not found/)
    return true
  })
})

test('no registered tool declares a project parameter', () => {
  const h = harness()
  for (const [name, definition] of h.definitions) {
    const schema = definition.parameters as { properties?: Record<string, unknown> }
    assert.ok(!Object.hasOwn(schema.properties ?? {}, 'project'), `${name} must not declare a project parameter`)
  }
})
