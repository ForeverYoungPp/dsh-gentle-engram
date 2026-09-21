/**
 * Plugin configuration: defaults, environment overrides, and validation.
 *
 * Environment variables follow the upstream Pi adapter so existing Engram
 * users need to learn nothing new: `ENGRAM_URL`, `ENGRAM_BIN`, `ENGRAM_PORT`.
 *
 * @module dsh-gentle-engram/config
 */

/** Fully resolved plugin configuration. */
export interface EngramConfig {
  /** Engram binary used to spawn `serve` when no external server is configured. */
  readonly binary: string
  /** Externally managed base URL. When set the plugin never spawns or heals a server. */
  readonly url: string | undefined
  /** TCP port for an implicitly owned server. */
  readonly port: number
  /** Observation text limit for the injected context block. */
  readonly contextLimit: number
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

/** Raw config as it appears in `cordis.patch.yml`. */
export interface RawEngramConfig {
  readonly binary?: unknown
  readonly url?: unknown
  readonly port?: unknown
  readonly contextLimit?: unknown
  readonly captureToolResults?: unknown
  readonly capturePrompts?: unknown
  readonly requestTimeoutMs?: unknown
  readonly startupTimeoutMs?: unknown
  readonly fetchMaxAttempts?: unknown
}

const KNOWN_KEYS = new Set([
  'binary', 'url', 'port', 'contextLimit', 'captureToolResults', 'capturePrompts',
  'requestTimeoutMs', 'startupTimeoutMs', 'fetchMaxAttempts',
])

/** Defaults for every non-environment field. */
export const DEFAULT_CONFIG: EngramConfig = {
  binary: 'engram',
  url: undefined,
  port: 7437,
  contextLimit: 8000,
  captureToolResults: true,
  capturePrompts: true,
  requestTimeoutMs: 3000,
  startupTimeoutMs: 10_000,
  fetchMaxAttempts: 3,
}

/** Env override helper: first non-blank value wins. */
function envString(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

function envPort(): number | undefined {
  const raw = envString('ENGRAM_PORT')
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined
}

/** Keep an override only when it is the right primitive and finite. */
function pickNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const value = Math.trunc(raw)
  return value >= min && value <= max ? value : fallback
}

function pickBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

function pickString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback
}

/**
 * Resolve raw plugin config plus environment into a complete configuration.
 * Unknown keys are reported so a typo in `cordis.patch.yml` is visible rather
 * than silently ignored.
 *
 * @param raw - the config object handed to the plugin.
 * @param warn - diagnostic sink for unknown keys.
 */
export function resolveConfig(raw: RawEngramConfig | undefined, warn: (message: string) => void): EngramConfig {
  const source = raw ?? {}
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) warn(`unknown config key "${key}" was ignored`)
  }
  const url = envString('ENGRAM_URL') ?? (typeof source.url === 'string' && source.url.trim().length > 0
    ? source.url.trim()
    : undefined)
  return {
    binary: envString('ENGRAM_BIN') ?? pickString(source.binary, DEFAULT_CONFIG.binary),
    url,
    port: envPort() ?? pickNumber(source.port, DEFAULT_CONFIG.port, 1, 65_535),
    contextLimit: pickNumber(source.contextLimit, DEFAULT_CONFIG.contextLimit, 200, 200_000),
    captureToolResults: pickBoolean(source.captureToolResults, DEFAULT_CONFIG.captureToolResults),
    capturePrompts: pickBoolean(source.capturePrompts, DEFAULT_CONFIG.capturePrompts),
    requestTimeoutMs: pickNumber(source.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 100, 120_000),
    startupTimeoutMs: pickNumber(source.startupTimeoutMs, DEFAULT_CONFIG.startupTimeoutMs, 500, 300_000),
    fetchMaxAttempts: pickNumber(source.fetchMaxAttempts, DEFAULT_CONFIG.fetchMaxAttempts, 1, 8),
  }
}
