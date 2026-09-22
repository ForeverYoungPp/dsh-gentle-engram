import assert from 'node:assert/strict'
import { test } from 'node:test'

import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { losslessJson } from './json.ts'

/**
 * The defect these tests guard: a server payload carrying `-0` (Go marshals a
 * negative-zero float64 that way) is rejected by the host as "not lossless
 * JSON", which fails the whole tool call. These tests pin the normalization
 * and the host contract that motivates it.
 */

test('replaces negative zero with 0 at every depth and touches nothing else', () => {
  const payload = {
    rank: -0,
    label: 'rows',
    rows: [{ rank: -0, note: 'first' }, { rank: -0.5 }, { rank: 0 }],
    ok: true,
    missing: null,
  }

  const normalized = losslessJson(payload)

  assert.equal(Object.is(normalized.rank, 0), true, 'top-level -0 must normalize to 0')
  assert.equal(Object.is(normalized.rows[0].rank, 0), true, 'nested -0 must normalize to 0')
  assert.equal(normalized.rows[1].rank, -0.5, 'a negative non-zero must stay untouched')
  assert.equal(Object.is(normalized.rows[2].rank, 0), true, 'a plain zero must stay as-is')
  assert.deepEqual(normalized, {
    rank: 0,
    label: 'rows',
    rows: [{ rank: 0, note: 'first' }, { rank: -0.5 }, { rank: 0 }],
    ok: true,
    missing: null,
  })
  assert.deepEqual(Object.keys(normalized), Object.keys(payload), 'key order must be preserved')
  assert.deepEqual(Object.keys(normalized.rows[0]), Object.keys(payload.rows[0]), 'nested key order must be preserved')
})

test('the host validator rejects the raw negative zero and accepts the normalized value', () => {
  const payload = JSON.parse('{"rank":-0,"rows":[{"rank":-0}]}') as { rank: number; rows: { rank: number }[] }

  assert.equal(snapshotJsonValue(payload), undefined, 'the raw payload must be rejected by the host validator')

  const normalized = losslessJson(payload)
  assert.notEqual(snapshotJsonValue(normalized), undefined, 'the normalized payload must satisfy the host validator')
})

test('passes non-plain values through unchanged and does not over-normalize', () => {
  assert.equal(losslessJson('rank=-0'), 'rank=-0')
  assert.equal(losslessJson(42), 42)
  assert.equal(losslessJson(-0.5), -0.5)
  assert.equal(losslessJson(true), true)
  assert.equal(losslessJson(null), null)

  const notJson = new Date(0)
  assert.equal(losslessJson(notJson), notJson, 'a non-plain object must be returned as-is, not rebuilt')

  assert.equal(Object.is(losslessJson(-0), 0), true, 'a bare -0 is still normalized')
})
