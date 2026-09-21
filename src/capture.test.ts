import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { ArchiveOutcome, buildRecoveryNotice } from './capture.ts'

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
