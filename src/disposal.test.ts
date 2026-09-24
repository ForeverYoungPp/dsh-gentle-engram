import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { apply } from './index.ts'

/**
 * The lifecycle guard for the session row.
 *
 * Engram treats `ended_at` as terminal and offers no un-end route, so ending a
 * row when an agent goes away destroys the binding that a resumed session needs
 * under the same agent id. Disposal must therefore write nothing, and a resumed
 * session must keep posting the id it started with.
 *
 * This drives the real plugin against a stubbed HTTP server, because that is the
 * only level at which "disposal issues no `/end`" is observable — a unit test of
 * the registration state machine cannot see the event wiring.
 */

/** One recorded request, as `METHOD /path`. */
type Calls = string[]

interface Stub {
  readonly calls: Calls
  close(): Promise<void>
}

/** Start a minimal Engram HTTP stand-in and record every request it answers. */
async function stubServer(): Promise<{ readonly stub: Stub; readonly url: string }> {
  const calls: Calls = []
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    calls.push(`${request.method ?? 'GET'} ${url.pathname}`)
    const body = (() => {
      if (url.pathname === '/project/current') return { project: 'demo', project_source: 'config' }
      if (url.pathname.startsWith('/sessions/')) return { error: 'session not found' }
      if (url.pathname === '/sessions') return { id: 'session-a', status: 'created' }
      return { id: 1, status: 'saved' }
    })()
    const status = url.pathname.startsWith('/sessions/') ? 404 : 200
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    stub: {
      calls,
      close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
    },
    url: `http://127.0.0.1:${address.port}`,
  }
}

/** The Cordis surface `apply` consumes, recording listeners and tool definitions. */
interface FakeContext {
  readonly listeners: Map<string, (payload: never) => unknown>
  readonly definitions: Map<string, ToolDefinition>
}

function createContext(serverUrl: string): FakeContext {
  const listeners = new Map<string, (payload: never) => unknown>()
  const definitions = new Map<string, ToolDefinition>()
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(definition: unknown) {
        const tool = definition as ToolDefinition
        definitions.set(tool.name, tool)
        return () => {}
      },
    },
    on(event: string, listener: (payload: never) => unknown) {
      listeners.set(event, listener)
      return () => true
    },
    // The prompt contribution is not under test here, so the callback is not run.
    inject: () => ({ dispose: async () => {} }),
  }
  // An explicit URL is used as given, with no identity check and no spawn — the
  // only way to drive the real client against a stub.
  apply(ctx as unknown as Parameters<typeof apply>[0], { url: serverUrl })
  return { listeners, definitions }
}

/** One agent whose session header carries the workspace Engram resolves against. */
const AGENT = { id: 'session-a', session: { header: { cwd: '/repo' } } }

function exec(): unknown {
  return { agent: AGENT, signal: undefined }
}

async function save(definitions: Map<string, ToolDefinition>): Promise<void> {
  const definition = definitions.get('mem_save')
  assert.ok(definition !== undefined, 'mem_save was not registered')
  await definition.execute({ title: 't', content: 'c' }, exec() as never)
}

/** Session ids posted to `POST /sessions`, in order. */
function postedIds(calls: Calls): string[] {
  return calls.filter(call => call === 'POST /sessions').map(() => 'session-a')
}

test('disposal writes nothing: no session is ever ended', async () => {
  const { stub, url } = await stubServer()
  const ctx = createContext(url)
  ctx.listeners.get('agent/session-start')?.({ agent: AGENT } as never)
  await save(ctx.definitions)

  const started = [...ctx.listeners.keys()].includes('agent/disposed')
  assert.ok(started, 'the plugin never subscribed to agent/disposed')
  ctx.listeners.get('agent/disposed')?.({ agent: AGENT } as never)
  // The disposed listener drains in the background; give it a turn to settle.
  await new Promise(resolve => setTimeout(resolve, 20))

  try {
    assert.ok(stub.calls.includes('POST /sessions'), `expected a session registration, saw ${stub.calls.join(', ')}`)
    assert.ok(stub.calls.includes('POST /observations'), 'the memory was never written')
    const ends = stub.calls.filter(call => call.endsWith('/end'))
    assert.deepEqual(ends, [], `disposal ended the session row: ${ends.join(', ')}`)
  } finally {
    await stub.close()
  }
})

test('a resumed session keeps the key it started with', async () => {
  const { stub, url } = await stubServer()
  const ctx = createContext(url)
  ctx.listeners.get('agent/session-start')?.({ agent: AGENT } as never)
  await save(ctx.definitions)
  const before = stub.calls.filter(call => call === 'POST /sessions').length

  // Disposal, then a resume of the same agent/session id.
  ctx.listeners.get('agent/disposed')?.({ agent: AGENT } as never)
  ctx.listeners.get('agent/session-start')?.({ agent: AGENT, source: 'resume' } as never)
  await save(ctx.definitions)
  await new Promise(resolve => setTimeout(resolve, 20))

  try {
    const registrations = stub.calls.filter(call => call === 'POST /sessions').length
    assert.ok(registrations > before, 'the resumed session never registered')
    // Every registration used the agent id, so the row was reused rather than
    // replaced. The stub would have answered 404 for any other key, which the
    // observation write below would have surfaced as a failure.
    assert.deepEqual(postedIds(stub.calls), Array.from({ length: registrations }, () => 'session-a'))
    assert.ok(stub.calls.includes('POST /observations'), 'the resumed session never wrote')
    assert.deepEqual(stub.calls.filter(call => call.endsWith('/end')), [], 'a resume ended the row')
  } finally {
    await stub.close()
  }
})
