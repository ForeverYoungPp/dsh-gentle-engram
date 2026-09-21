/**
 * Background capture: compaction archival, prompt capture, passive tool-result
 * capture, and the outcome-specific recovery guidance that follows a
 * compaction.
 *
 * The four-way outcome taxonomy is ported from the upstream Pi adapter. Its
 * point is that "we do not know whether the write landed" is a distinct state
 * that must never be retried blindly.
 *
 * @module dsh-gentle-engram/capture
 */

import type { EngramClient, Logger } from './engram/client.ts'
import type { JsonValue } from './json.ts'
import type { SessionState } from './session.ts'

/** How one compaction archive ended. */
export const ArchiveOutcome = {
  /** Engram acknowledged the write. */
  Confirmed: 'confirmed',
  /** The write definitely failed. */
  Failed: 'failed',
  /** A timeout: the write may or may not have landed. */
  Unknown: 'unknown',
  /** No trustworthy session or project, so no attributed write was attempted. */
  Unavailable: 'unavailable',
} as const

export type ArchiveOutcome = typeof ArchiveOutcome[keyof typeof ArchiveOutcome]

/** Topic key that marks an observation as compaction-recovery state. */
export const COMPACTION_TOPIC_KEY = 'session/compaction-recovery'

/** Structural shape of a content block we can read text from. */
interface TextishBlock {
  readonly type?: unknown
  readonly text?: unknown
}

/**
 * Flatten content blocks to text. DSH's `compaction/summary` payload carries
 * `data.summary` as `ContentBlock[]`, not as a string.
 */
export function blocksToText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => {
      if (typeof block === 'string') return block
      if (block === null || typeof block !== 'object') return ''
      const candidate = block as TextishBlock
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .filter(part => part.length > 0)
    .join('\n')
    .trim()
}

/** Archive a session summary as an observation. */
export async function archiveSummary(
  client: EngramClient,
  state: SessionState,
  project: string,
  content: string,
): Promise<JsonValue> {
  return client.request<JsonValue>('/observations', {
    method: 'POST',
    body: {
      session_id: state.engramSessionId,
      project,
      type: 'session_summary',
      title: 'Session summary',
      content,
      scope: 'project',
    },
  })
}

/**
 * Archive one compacted summary, mapping the transport outcome onto the
 * taxonomy the guidance depends on.
 */
export async function archiveCompaction(
  client: EngramClient,
  state: SessionState,
  project: string,
  summary: string,
): Promise<ArchiveOutcome> {
  try {
    const result = await client.requestResult('/observations', {
      method: 'POST',
      body: {
        session_id: state.engramSessionId,
        project,
        type: 'session_summary',
        title: 'Compaction recovery summary',
        content: summary,
        scope: 'project',
        topic_key: COMPACTION_TOPIC_KEY,
      },
    })
    // A timeout means the request may already have been applied server-side.
    return result.timedOutMethod === undefined ? ArchiveOutcome.Confirmed : ArchiveOutcome.Unknown
  } catch {
    return ArchiveOutcome.Failed
  }
}

function manualFallback(project: string): string {
  return 'CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\n'
    + 'The agent has access to Engram persistent memory through the mem_* tools.\n'
    + `FIRST ACTION REQUIRED: call mem_session_summary with the content of this compacted summary. Use project '${project}'. `
    + 'This preserves what was accomplished before compaction. Do this BEFORE any other work.'
}

function persistedAcknowledgement(project: string): string {
  return `The compaction recovery summary was already saved to Engram (${project}) by dsh-gentle-engram. `
    + 'No manual mem_session_summary call is needed for this compaction. '
    + 'Call mem_context if you need additional recent project memory.'
}

function unknownArchiveInstruction(project: string): string {
  return `Compaction recovery could not confirm whether the summary was saved to Engram (${project}). `
    + 'Do NOT retry and do NOT call mem_session_summary yet, because that could duplicate the summary. '
    + 'First verify with mem_search or mem_doctor; save it once only if it is absent.'
}

function unavailableRecoveryInstruction(): string {
  return 'CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\n'
    + 'dsh-gentle-engram could not safely confirm the runtime session and project, so it did not archive the summary. '
    + 'Before saving manually, verify the active Engram session and project with mem_current_project or mem_doctor. '
    + 'Save the summary once only after that verification.'
}

/**
 * Build the guidance injected into the turn after a compaction.
 *
 * @param project - resolved project key, for attribution in the text.
 * @param context - session-scoped recovery context, when Engram provided any.
 * @param outcome - how the archive ended.
 */
export function buildRecoveryNotice(
  project: string,
  context: string | undefined,
  outcome: ArchiveOutcome,
): string {
  const instruction = outcome === ArchiveOutcome.Confirmed
    ? persistedAcknowledgement(project)
    : outcome === ArchiveOutcome.Unknown
      ? unknownArchiveInstruction(project)
      : outcome === ArchiveOutcome.Unavailable
        ? unavailableRecoveryInstruction()
        : manualFallback(project)
  const prefix = context === undefined ? '' : `${context}\n\n`
  return `${prefix}${instruction}`
}

/** Log a background capture failure without surfacing it as a tool error. */
export function warnCapture(logger: Logger, what: string, error: unknown): void {
  logger.warn(`engram ${what} failed: ${error instanceof Error ? error.message : String(error)}`)
}
