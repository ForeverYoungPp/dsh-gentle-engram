import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { ArchiveOutcome, buildRecoveryNotice, passivePayload } from './capture.ts'

// P4: the notice carries the archive outcome and nothing else. This pins the four
// instructions — they are now the whole notice — and that buildRecoveryNotice
// never emits a context block of its own. The call site that decided not to read
// Engram's session-scoped context back is guarded by the source check below.
test('buildRecoveryNotice is instruction-only for every archive outcome', () => {
  const expected: ReadonlyArray<readonly [ArchiveOutcome, string]> = [
    [ArchiveOutcome.Confirmed, 'already saved to Engram'],
    [ArchiveOutcome.Unknown, 'could not confirm whether the summary was saved'],
    [ArchiveOutcome.Unavailable, 'could not safely confirm the runtime session'],
    [ArchiveOutcome.Failed, 'FIRST ACTION REQUIRED'],
  ]
  for (const [outcome, phrase] of expected) {
    const notice = buildRecoveryNotice('some-project', undefined, outcome)
    assert.ok(notice.includes(phrase), `${outcome}: lost its instruction`)
    assert.ok(notice.includes('some-project') || outcome === ArchiveOutcome.Unavailable,
      `${outcome}: lost the project attribution`)
    assert.ok(!notice.includes('## Memory from'), `${outcome}: injected a context block`)
  }
})

// The unit test above cannot see the compaction handler, so a re-added read-back
// would leave it green. Assert the call site's shape instead: the notice is built
// with no context argument, which is the P4 decision itself.
test('the compaction call site passes no Engram context to the notice', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('buildRecoveryNotice(project, undefined, outcome)'),
    'the compaction notice is no longer built without context')
})

// Passive capture: the gate and the payload must be the same string. The gate
// used to test the full result while the payload was sliced from the start, so
// a header past the cut passed the gate and was removed before sending — a
// request Engram's parser could only find nothing in.

test('passivePayload returns short text with a learning header unchanged', () => {
  const text = 'notes\n## Key Learnings\n- one\n'
  assert.equal(passivePayload(text, 20_000), text)
})

test('passivePayload slices from the header when the header sits past the limit', () => {
  const padding = 'x'.repeat(500)
  const text = `${padding}\n## Key Learnings\n- one\n`
  const payload = passivePayload(text, 100)
  assert.ok(payload !== undefined, 'the header should be found')
  assert.ok(payload.startsWith('## Key Learnings'), `payload must start at the header, got: ${payload.slice(0, 40)}`)
  assert.ok(payload.length <= 100, `payload of ${payload.length} chars exceeds the limit`)
})

test('passivePayload returns undefined when there is no learning section', () => {
  assert.equal(passivePayload('## Notes\n- nothing to extract\n', 20_000), undefined)
})

test('passivePayload recognizes the Spanish learning header', () => {
  const text = '## Aprendizajes Clave\n- dato\n'
  assert.equal(passivePayload(text, 20_000), text)
})
