/**
 * Plugin configuration: the Cordis `Config` schema, defaults, and environment
 * overrides.
 *
 * `Config` is the single source of truth for the eight fields: cordis validates
 * it and applies defaults before `apply` runs, and `resolveConfig` reuses the
 * same constraints for the environment layer. Invalid input fails the plugin
 * load instead of being silently replaced by a default.
 *
 * Environment variables follow the upstream Pi adapter so existing Engram
 * users need to learn nothing new: `ENGRAM_URL`, `ENGRAM_BIN`, `ENGRAM_PORT`.
 *
 * @module dsh-gentle-engram/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Fully resolved plugin configuration. */
export interface EngramConfig {
  /** Engram binary used to spawn `serve` when no external server is configured. */
  readonly binary: string
  /** Externally managed base URL. When set the plugin never spawns or heals a server. */
  readonly url: string | undefined
  /** TCP port for an implicitly owned server. */
  readonly port: number
  /** Capture non-Engram tool results as passive observations. */
  readonly captureToolResults: boolean
  /** Capture human prompts. */
  readonly capturePrompts: boolean
  /** Per-request HTTP timeout. */
  readonly requestTimeoutMs: number
  /** Total budget for one server startup attempt. */
  readonly startupTimeoutMs: number
  /** Attempts for one replay-safe request. */
  readonly fetchMaxAttempts: number
}

/**
 * The eight config fields, declared once.
 *
 * One object drives three consumers that would otherwise drift apart: the
 * schema body, the known-key set, and the re-validation of environment values.
 * `natural()` is `number().step(1).min(0)`, so every explicit `.min(lo)`
 * overrides its implicit zero and non-integers are rejected by the step check —
 * no value is ever truncated.
 */
const FIELDS = {
  binary: Schema.string().pattern(/\S/).default('engram'),
  // Schema fields cannot default to `undefined`, so `url` uses the empty string
  // as a sentinel and `resolveConfig` folds it back to `string | undefined`.
  url: Schema.string().default(''),
  port: Schema.natural().min(1).max(65_535).default(7437),
  captureToolResults: Schema.boolean().default(true),
  capturePrompts: Schema.boolean().default(true),
  requestTimeoutMs: Schema.natural().min(100).max(120_000).default(3000),
  startupTimeoutMs: Schema.natural().min(500).max(300_000).default(10_000),
  fetchMaxAttempts: Schema.natural().min(1).max(8).default(3),
}

/** The plugin config, as cordis consumes it. */
export const Config = Schema.object(FIELDS)

/** Schema input: every field optional, unknown keys tolerated by the schema itself. */
export type ConfigInput = Schemastery.TypeS<typeof Config>

/** Schema output: the validated, default-filled object cordis hands to `apply`. */
export type ConfigOutput = Schemastery.TypeT<typeof Config>

const KNOWN_KEYS = new Set(Object.keys(FIELDS))

/**
 * Reject a config key the schema does not declare.
 *
 * The schema cannot do this itself: schemastery's object resolver merges the
 * input into the result, so an unknown key survives validation untouched. A
 * typo in `cordis.patch.yml` has to fail the load, not become a silent no-op.
 */
function assertKnownKeys(raw: ConfigInput | undefined): void {
  if (raw === undefined) return
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new TypeError(`unknown config key "${key}" (expected one of ${[...KNOWN_KEYS].join(', ')})`)
    }
  }
}

/** Env override helper: first non-blank value wins. */
function envString(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Read `ENGRAM_PORT`, validated by the same schema as the yml value.
 *
 * A malformed value is fatal: falling back to the yml or the default would
 * present a bad override as a working one.
 */
function envPort(): number | undefined {
  const raw = envString('ENGRAM_PORT')
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new TypeError(`invalid ENGRAM_PORT "${raw}": expected a number`)
  try {
    return FIELDS.port(value)
  } catch (error) {
    throw new TypeError(`invalid ENGRAM_PORT "${raw}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Bearer token for a token-protected Engram server (`ENGRAM_HTTP_TOKEN`).
 *
 * Read on every call, exactly as the server reads it, so a token that appears
 * or disappears needs no restart. Deliberately NOT trimmed like the other
 * environment values: the server compares this string byte-for-byte, so a
 * trimmed copy would authenticate as a different token. Only the empty string
 * counts as unset, mirroring the server's own `os.Getenv(...) == ""` check.
 */
export function engramAuthToken(): string | undefined {
  const value = process.env.ENGRAM_HTTP_TOKEN
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Resolve raw plugin config plus environment into a complete configuration.
 *
 * Order: strict key check → schema validation/defaults → validated environment
 * precedence → `url` sentinel fold. Validation precedes environment layering so
 * a valid override can never excuse an invalid yml value.
 *
 * @param raw - the config object handed to the plugin by cordis.
 */
export function resolveConfig(raw?: ConfigInput): EngramConfig {
  assertKnownKeys(raw)
  const validated = Config(raw ?? {})
  const ymlUrl = validated.url.trim()
  // "External server configured" keys off `undefined`, so a blank URL has to
  // fold here and nowhere else; no resolved config may expose `''`.
  const url = envString('ENGRAM_URL') ?? (ymlUrl === '' ? undefined : ymlUrl)
  return {
    binary: envString('ENGRAM_BIN') ?? validated.binary.trim(),
    url,
    port: envPort() ?? validated.port,
    captureToolResults: validated.captureToolResults,
    capturePrompts: validated.capturePrompts,
    requestTimeoutMs: validated.requestTimeoutMs,
    startupTimeoutMs: validated.startupTimeoutMs,
    fetchMaxAttempts: validated.fetchMaxAttempts,
  }
}
