/**
 * Colocated tests for the Cordis `Config` schema and the `resolveConfig`
 * boundary. Standard library only (`node:test`, `node:assert/strict`), like the
 * rest of the suite: the repo adds no test dependency.
 *
 * @module dsh-gentle-engram/config.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, resolveConfig, type ConfigInput, type EngramConfig } from './config.ts'
import { Config as IndexConfig } from './index.ts'

/** The eight defaults, written out independently of the schema as an oracle. */
const DEFAULTS: EngramConfig = {
  binary: 'engram',
  url: undefined,
  port: 7437,
  captureToolResults: true,
  capturePrompts: true,
  requestTimeoutMs: 3000,
  startupTimeoutMs: 10_000,
  fetchMaxAttempts: 3,
}

/** Deliberately invalid inputs bypass the compiler; the schema is the gate. */
const raw = (value: Record<string, unknown>): ConfigInput => value as ConfigInput

const ENV_KEYS = ['ENGRAM_URL', 'ENGRAM_BIN', 'ENGRAM_PORT'] as const

/**
 * Run `fn` with exactly the named environment values set — every other
 * recognised variable is unset — and restore the previous environment even
 * when `fn` throws, so no case can leak into the next one.
 */
function withEnv<T>(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => T): T {
  const saved = ENV_KEYS.map(key => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('an out-of-range numeric yml value throws a ValidationError', () => {
  const cases = [
    { port: 0 },
    { port: 65536 },
    { port: 99999 },
    { requestTimeoutMs: 99 },
    { requestTimeoutMs: 120001 },
    { startupTimeoutMs: 499 },
    { startupTimeoutMs: 300001 },
    { fetchMaxAttempts: 0 },
    { fetchMaxAttempts: 9 },
  ]
  for (const input of cases) {
    assert.throws(() => Config(raw(input)), { name: 'ValidationError' }, `expected ${JSON.stringify(input)} to be rejected`)
  }
})

test('a wrong-typed numeric yml value throws a ValidationError', () => {
  assert.throws(() => Config(raw({ port: 'abc' })), { name: 'ValidationError' })
})

test('a non-integer numeric yml value throws instead of being truncated', () => {
  assert.throws(() => Config(raw({ port: 1.5 })), { name: 'ValidationError' })
  assert.throws(() => Config(raw({ requestTimeoutMs: 3000.5 })), { name: 'ValidationError' })
})

test('a blank binary throws a ValidationError', () => {
  assert.throws(() => Config(raw({ binary: '' })), { name: 'ValidationError' })
  assert.throws(() => Config(raw({ binary: '   ' })), { name: 'ValidationError' })
})

test('a wrong-typed boolean yml value throws a ValidationError', () => {
  assert.throws(() => Config(raw({ capturePrompts: 'yes' })), { name: 'ValidationError' })
})

test('an unknown config key throws an error naming the key', () => {
  assert.throws(() => resolveConfig(raw({ bogus: 1 })), /bogus/)
})

test('a malformed environment port throws an error naming ENGRAM_PORT', () => {
  assert.throws(() => withEnv({ ENGRAM_PORT: 'abc' }, () => resolveConfig(raw({}))), /ENGRAM_PORT/)
  assert.throws(() => withEnv({ ENGRAM_PORT: '99999' }, () => resolveConfig(raw({}))), /ENGRAM_PORT/)
  assert.throws(() => withEnv({ ENGRAM_PORT: '1.5' }, () => resolveConfig(raw({}))), /ENGRAM_PORT/)
})

test('an absent or empty config resolves to every default', () => {
  withEnv({}, () => {
    assert.deepEqual(resolveConfig(undefined), DEFAULTS)
    assert.deepEqual(resolveConfig({}), DEFAULTS)
  })
})

test('the schema itself fills every default from an empty object', () => {
  withEnv({}, () => {
    // `url` is the sentinel here: the fold to `undefined` happens in resolveConfig.
    assert.deepEqual(Config(raw({})), { ...DEFAULTS, url: '' })
  })
})

test('boundary values are preserved exactly', () => {
  const cases: readonly [Record<string, unknown>, number][] = [
    [{ port: 1 }, 1],
    [{ port: 65535 }, 65535],
    [{ requestTimeoutMs: 100 }, 100],
    [{ requestTimeoutMs: 120000 }, 120000],
    [{ startupTimeoutMs: 500 }, 500],
    [{ startupTimeoutMs: 300000 }, 300000],
    [{ fetchMaxAttempts: 1 }, 1],
    [{ fetchMaxAttempts: 8 }, 8],
  ]
  withEnv({}, () => {
    for (const [input, expected] of cases) {
      const [field] = Object.keys(input)
      assert.equal((Config(raw(input)) as Record<string, unknown>)[field], expected, `expected ${JSON.stringify(input)} to survive`)
    }
  })
})

test('environment variables override yml values', () => {
  withEnv({ ENGRAM_PORT: '1234' }, () => {
    assert.equal(resolveConfig(raw({ port: 7437 })).port, 1234)
  })
  withEnv({ ENGRAM_BIN: '/usr/local/bin/engram' }, () => {
    assert.equal(resolveConfig(raw({ binary: 'other' })).binary, '/usr/local/bin/engram')
  })
  withEnv({ ENGRAM_URL: 'http://127.0.0.1:9000' }, () => {
    assert.equal(resolveConfig(raw({ url: 'http://example.test' })).url, 'http://127.0.0.1:9000')
  })
})

test('a valid environment value cannot excuse an invalid yml value', () => {
  withEnv({ ENGRAM_PORT: '1234' }, () => {
    assert.throws(() => resolveConfig(raw({ port: 'abc' })), { name: 'ValidationError' })
  })
})

test('a blank environment value is still unset', () => {
  withEnv({ ENGRAM_PORT: '' }, () => {
    assert.equal(resolveConfig(raw({ port: 1234 })).port, 1234)
    assert.equal(resolveConfig(raw({})).port, DEFAULTS.port)
  })
  withEnv({ ENGRAM_PORT: '   ' }, () => {
    assert.equal(resolveConfig(raw({ port: 1234 })).port, 1234)
    assert.equal(resolveConfig(raw({})).port, DEFAULTS.port)
  })
})

test('the url sentinel folds to undefined and a configured url survives', () => {
  withEnv({}, () => {
    assert.equal(resolveConfig(raw({})).url, undefined)
    assert.equal(resolveConfig(raw({ url: '' })).url, undefined)
    assert.equal(resolveConfig(raw({ url: 'http://example.test' })).url, 'http://example.test')
  })
})

test('schemastery passes unknown keys through, so the explicit check is load-bearing', () => {
  const validated = Config(raw({ bogus: 1 })) as Record<string, unknown>
  assert.equal(validated.bogus, 1)
})

test('Config is the same value exported by the plugin entry module', () => {
  assert.equal(IndexConfig, Config)
})

// --- Triangulation: held-out cases the schema-only or trim-free readings would fail.

test('a whitespace-only yml url folds to undefined like the empty sentinel', () => {
  withEnv({}, () => {
    assert.equal(resolveConfig(raw({ url: '   ' })).url, undefined)
  })
})

test('a padded yml binary is normalized, not rejected', () => {
  withEnv({}, () => {
    assert.equal(resolveConfig(raw({ binary: '  engram  ' })).binary, 'engram')
  })
})

test('a blank ENGRAM_BIN or ENGRAM_URL falls through to the yml value', () => {
  withEnv({ ENGRAM_BIN: '', ENGRAM_URL: '' }, () => {
    const resolved = resolveConfig(raw({ binary: 'other', url: 'http://example.test' }))
    assert.equal(resolved.binary, 'other')
    assert.equal(resolved.url, 'http://example.test')
  })
})

test('an unknown key is rejected even beside valid keys, and as a TypeError', () => {
  assert.throws(() => resolveConfig(raw({ port: 1, bogus: 1 })), (error: unknown) => {
    assert.ok(error instanceof TypeError, 'expected a TypeError')
    assert.match(error.message, /bogus/)
    return true
  })
})

test('resolveConfig rejects a non-integer field instead of returning a truncated one', () => {
  withEnv({}, () => {
    assert.throws(() => resolveConfig(raw({ port: 1.5 })), { name: 'ValidationError' })
  })
  withEnv({ ENGRAM_PORT: '0' }, () => {
    assert.throws(() => resolveConfig(raw({})), /ENGRAM_PORT/)
  })
})
