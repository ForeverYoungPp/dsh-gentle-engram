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
