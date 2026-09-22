/**
 * A structural JSON value type.
 *
 * Declared locally instead of importing `@deepseek-ai/dsh-util-values` so the
 * plugin's published type surface does not add a dependency for one alias.
 * Structurally identical to the harness's `JsonValue`, so it is assignable
 * wherever a tool output is required.
 *
 * @module dsh-gentle-engram/json
 */

/** Any losslessly JSON-serializable value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Return the same JSON value with every negative zero replaced by `0`.
 *
 * The host validates tool output as *lossless JSON* and rejects `-0`
 * (`Object.is(value, -0)`), failing the whole tool call with
 * "value is not lossless JSON". `JSON.parse` preserves a `-0` the server sent,
 * so any payload could carry one. Reads nothing else and changes nothing else.
 */
export function losslessJson<T>(value: T): T {
  if (typeof value === 'number') return (Object.is(value, -0) ? 0 : value) as T
  if (Array.isArray(value)) return value.map((item) => losslessJson(item)) as T
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) copy[key] = losslessJson(item)
  return copy as T
}
