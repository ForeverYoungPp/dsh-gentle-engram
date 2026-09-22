import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { apply } from './index.ts'
import { PROTOCOL_TEXT } from './protocol.ts'

/**
 * The prompt contribution is protocol-only, matching the reference Pi adapter.
 * Project memory is pull-based — the model calls `mem_context` — so nothing is
 * fetched or injected at session start. These two guards pin the removal of the
 * ambient project-memory block: one reads the source (the block is deleted, not
 * merely bypassed), the other drives the real contributor with a minimal Cordis
 * stand-in.
 */

/** Built from parts so this file never contains the forbidden heading itself. */
const REMOVED_HEADING = ['Recovered', 'Engram', 'memory'].join(' ')

// Source shape is the negative control for the deletion: a behavioural test
// alone would stay green if the old fetch were re-added behind a check that
// happens to be false in the test's conditions.
test('index.ts no longer builds or fetches the ambient memory block', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.ok(!source.includes(REMOVED_HEADING), `index.ts still assembles the ${REMOVED_HEADING} block`)
  assert.ok(!source.includes('/context?project='), 'session start still fetches the project context')
})

/** The provider entry `apply` registers, as recorded by the fake context. */
interface Contributor {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: { readonly agent?: { readonly id: string } }) => string)
}

/** Minimal Cordis stand-in: `inject` runs its callback so `apply` wires the provider. */
function createHarness(): { readonly contributor: () => Contributor | undefined } {
  let contributor: Contributor | undefined
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: () => () => {} },
    on: () => () => false,
    inject: (
      _deps: readonly string[],
      callback: (scope: { readonly systemPrompt: { context(entry: Contributor): () => void } }) => void,
    ) => {
      callback({
        systemPrompt: {
          context(entry: Contributor): () => void {
            contributor = entry
            return () => {}
          },
        },
      })
      return { dispose: async () => {} }
    },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0], { url: 'http://127.0.0.1:1' })
  return { contributor: () => contributor }
}

test('the prompt contributor returns the protocol text alone for an untouched session', () => {
  const contributor = createHarness().contributor()
  assert.ok(contributor !== undefined, 'the systemPrompt contributor was never registered')
  assert.equal(typeof contributor.text, 'function')
  const text = contributor.text as (context: { agent: { id: string } }) => string
  const output = text({ agent: { id: 'session-x' } })
  assert.ok(!output.includes(REMOVED_HEADING), 'the contributor still emits a memory payload')
  assert.equal(output, PROTOCOL_TEXT, 'the contributor must return the protocol and nothing else')
})
