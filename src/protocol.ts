/**
 * The Engram memory protocol injected into every model request.
 *
 * Adapted from the upstream Pi adapter's `MEMORY_INSTRUCTIONS`. It is delivered
 * through `systemPrompt.context()`, which DSH re-projects after a surface
 * replacement, so the protocol survives compaction without per-turn splicing.
 *
 * @module dsh-gentle-engram/protocol
 */

/** Ordered context-provider name. */
export const PROTOCOL_CONTEXT_NAME = 'engram:protocol'

/** Provider order: after tool guidance, before volatile runtime context. */
export const PROTOCOL_CONTEXT_ORDER = 40

const PROTOCOL_TEXT = `## Engram Persistent Memory — Protocol

You have access to Engram, a persistent memory system that survives across sessions and compactions. These instructions are injected by dsh-gentle-engram, the DeepSeek Harness memory provider. Use the memory tools named in this section as the authoritative memory contract; do not infer alternative tool names from other integrations.

### WHEN TO SAVE (mandatory — not optional)

Call \`mem_save\` IMMEDIATELY after any of these:
- Bug fix completed
- Architecture or design decision made
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned

Format for \`mem_save\`:
- **title**: Verb + what — short, searchable
- **type**: bugfix | decision | architecture | discovery | pattern | config | preference
- **scope**: \`project\` (default) | \`personal\` | \`global\`
- **topic_key**: stable key for evolving decisions when relevant
- **content**:
  **What**: One sentence — what was done
  **Why**: What motivated it
  **Where**: Files or paths affected
  **Learned**: Gotchas, edge cases, things that surprised you

### DELIVERY GUARANTEE

Memory operations are internal bookkeeping, never the user-facing answer. Complete required memory work before composing the completed-task reply; send the complete answer as the final message of the turn with no later tool calls. If memory work fails or needs follow-up, still send the answer.

### WHEN TO SEARCH MEMORY

When the user asks to recall past work:
1. Start with \`mem_context\`, then search with 1–2 distinctive keywords.
2. Ordinary \`mem_search\` is scoped to the detected active project; its default \`match_mode:"all"\` means AND. For broad recall, use \`match_mode:"any"\` with \`all_projects:true\`. If a scoped search is empty, retry once this way before concluding no memory exists.
3. After hits, narrow follow-up searches by project, type, or \`match_mode:"all"\`, then use \`mem_get_observation\` for full content.

### SESSION CLOSE PROTOCOL

Before ending a session or saying "done", call \`mem_session_summary\` with Goal, Instructions, Discoveries, Accomplished, Next Steps, and Relevant Files. If \`mem_session_summary\` fails because Engram cannot detect a project, ask the user which project should receive the summary, then retry with \`project: "<name>"\`.

### MULTI-REPOSITORY WORKSPACES

If memory tools report an ambiguous project, the working directory contains more than one repository. Ask the user which project should receive the memory, or add \`.engram/config.json\` with \`{"project_name": "..."}\` at the workspace root. Do not guess.

### AFTER COMPACTION

When outcome-specific compaction recovery guidance is present, follow it. If a compacted summary appears without that guidance, save it immediately with \`mem_session_summary\`, then call \`mem_context\` before continuing.`

/** The static protocol text contributed to every assembly. */
export function protocolText(): string {
  return PROTOCOL_TEXT
}
