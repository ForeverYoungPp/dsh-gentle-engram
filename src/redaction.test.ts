import assert from 'node:assert/strict'
import { test } from 'node:test'

import { redactPrivateTags, redactText, redactUrlPath, redactValue } from './redaction.ts'

test('redactPrivateTags replaces multiple private blocks', () => {
  const input = 'a <private>x</private> b <private>y</private> c'
  assert.equal(redactPrivateTags(input), 'a [REDACTED] b [REDACTED] c')
})

test('redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone', () => {
  const input = 'keep <PRIVATE>line one\nLine Two</private> keep'
  assert.equal(redactPrivateTags(input), 'keep [REDACTED] keep')
  assert.equal(redactPrivateTags('no tags here'), 'no tags here')
})

test('redactUrlPath redacts a percent-encoded private query value and preserves URL shape', () => {
  const input = '/api/memory?note=%3Cprivate%3Etop%20secret%3C%2Fprivate%3E&keep=visible'
  const out = redactUrlPath(input)
  assert.equal(out, '/api/memory?note=%5BREDACTED%5D&keep=visible')
  const url = new URL(out, 'http://engram.local')
  assert.equal(url.pathname, '/api/memory')
  assert.equal(url.searchParams.get('note'), '[REDACTED]')
  assert.equal(url.searchParams.get('keep'), 'visible')
})

test('redactUrlPath redacts a private block in a path segment', () => {
  assert.equal(redactUrlPath('/api/memory/<private>abc</private>?tab=notes'), '/api/memory/[REDACTED]?tab=notes')
})

test('redactValue redacts nested strings and passes non-string primitives through', () => {
  const input = {
    message: '<private>token</private>',
    count: 3,
    active: true,
    missing: null,
    nested: { tags: ['<private>a</private>', 42, false] },
  }
  assert.deepEqual(redactValue(input), {
    message: '[REDACTED]',
    count: 3,
    active: true,
    missing: null,
    nested: { tags: ['[REDACTED]', 42, false] },
  })
})

test('redactText redacts then trims surrounding whitespace', () => {
  const input = '   \n <private>secret</private> padded \n  '
  assert.equal(redactText(input), '[REDACTED] padded')
})
