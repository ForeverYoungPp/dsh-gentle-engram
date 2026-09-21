/**
 * Explicit-private-block redaction for everything this plugin sends to Engram.
 *
 * Ported from the upstream Pi adapter (`private-redaction.js`). Upstream is
 * explicit that this is a convenience convention, **not** a secret scanner:
 * it only removes content the user deliberately wrapped in `<private>` tags.
 * We deliberately do NOT guess at credentials with regexes — the previous
 * version of this plugin dropped any line matching /password|token|secret/i,
 * which both missed real secrets and discarded useful code.
 *
 * @module dsh-gentle-engram/redaction
 */

const PRIVATE_TAG_PATTERN = /<private>[\s\S]*?<\/private>/gi

/** Replace every explicit private block with a marker. */
export function redactPrivateTags(value: string): string {
  return value.replace(PRIVATE_TAG_PATTERN, '[REDACTED]')
}

/**
 * Redact a relative URL path, including decoded query values, so a private
 * block cannot leak through a query string.
 */
export function redactUrlPath(path: string): string {
  const redacted = redactPrivateTags(path)
  try {
    const url = new URL(redacted, 'http://engram.local')
    const params = new URLSearchParams()
    for (const [key, value] of url.searchParams.entries()) params.append(key, redactPrivateTags(value))
    const query = params.toString()
    return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`
  } catch {
    return redacted
  }
}

/**
 * Recursively redact strings in an outgoing payload. Object and array shape is
 * preserved; non-string primitives pass through unchanged.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPrivateTags(value)
  if (Array.isArray(value)) return value.map(entry => redactValue(entry))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = redactValue(entry)
    return out
  }
  return value
}

/** Redact and trim captured text before it becomes a payload field. */
export function redactText(value: string): string {
  return redactPrivateTags(value).trim()
}
