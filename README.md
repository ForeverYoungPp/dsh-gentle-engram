# dsh-gentle-engram

[![npm](https://img.shields.io/npm/v/@ian_p/dsh-gentle-engram)](https://www.npmjs.com/package/@ian_p/dsh-gentle-engram)

HTTP-native [Engram](https://github.com/Gentleman-Programming/engram) persistent memory for
DeepSeek Harness. The plugin registers native `mem_*` tools, captures prompts and tool
learnings, and keeps a session's memory alive across compactions.

This is a **0.2.0 rewrite**. Version 0.1.x bridged Engram's MCP server; that approach could
not be made correct, for reasons recorded in [DESIGN.md](./docs/DESIGN.md).

## How it works

The plugin talks to `engram serve` over HTTP and inserts **no MCP row**: it owns the `mem_*`
tool surface itself, and attaches the calling session's identity to every operation.

| Capability | How |
| --- | --- |
| Resolve the project from **this session's** directory | `GET /project/current?cwd=` with the session's own working directory, so the answer belongs to that session rather than to a shared child process |
| Session-scoped compaction recovery | `GET /context/compaction?session_id=` returns the guidance belonging to the session that was compacted |
| A tool surface that travels with the package | the `mem_*` tools are registered through `ctx.tools.register`, so their schemas, output shape and error handling are defined and tested in this repository |

### The memory flow

```text
session start   resolve the project, then fetch the project context     (nothing is written)
first write     create the Engram session row, then attribute the write to it
every turn      capture the user prompt, and any tool result carrying a Key Learnings section
compaction      archive the summary, then inject outcome-specific recovery guidance
disposal        close the session row, best-effort and without a summary
```

## Requirements

- DeepSeek Harness 0.1.5-rc.2 or later.
- An Engram binary on `PATH` (or `ENGRAM_BIN`) that provides the `serve` subcommand.
  Verify with `engram serve` and `engram --version`.

## Installation

The published package:

```bash
dsh plugin --profile web add @ian_p/dsh-gentle-engram
```

Or a local checkout, which links `node_modules` to your working tree so a rebuild takes
effect without reinstalling:

```bash
dsh plugin --profile web add /path/to/dsh-gentle-engram
```

Restart DeepSeek Harness afterwards. The package is a Host bundle: its
`cordis.patch.yml` owns the lifecycle plugin and the tool surface.

> **Do not add a second Engram MCP row.** Two rows with the same `serverName` in one scope
> fail the profile at load. This bundle intentionally contributes none.

## Configuration

Set on the inserted row in your profile (or the host patch layer):

```yaml
- insert:
    - id: engram-memory
      name: '@ian_p/dsh-gentle-engram'
      config:
        binary: engram          # Engram executable used to spawn serve
        contextLimit: 8000      # characters of recovered context injected per session
        captureToolResults: true
        capturePrompts: true
```

Environment variables (same names as the upstream Pi adapter):

| Variable | Effect |
| --- | --- |
| `ENGRAM_URL` | Use an already-running server. The plugin then never spawns or restarts one. |
| `ENGRAM_BIN` | Engram executable path. |
| `ENGRAM_PORT` | Port for the implicitly owned server (default 7437). |

## Tools

Eighteen native tools, matching Engram's `agent` MCP profile except where noted:

`mem_save`, `mem_search`, `mem_context`, `mem_session_summary`, `mem_session_start`,
`mem_session_end`, `mem_get_observation`, `mem_suggest_topic_key`, `mem_capture_passive`,
`mem_save_prompt`, `mem_update`, `mem_current_project`, `mem_judge`, `mem_compare`,
`mem_doctor`, `mem_review`, `mem_pin`, `mem_unpin`.

Three deliberate differences from the MCP originals:

- **`mem_list_projects` is absent.** Its handler calls the store directly and Engram exposes
  no HTTP route for it. Use `mem_search` with `all_projects: true` instead.
- **`mem_delete` is absent.** Its route is behind `requireAuth`, so it would fail in a
  default installation.
- **`mem_session_start` / `mem_session_end` take no model-supplied session id.** Session
  identity belongs to the plugin; letting the model mint keys would desynchronise every
  later capture.

## Multi-repository workspaces

Engram refuses to guess which project a directory belongs to. If you start DeepSeek Harness
from a directory containing several repositories, project resolution fails and **no memory
is written** - deliberately, rather than filing memories under the wrong project.

Fix it by adding a config file at the workspace root:

```json
{ "project_name": "my-project" }
```

The plugin logs an actionable warning when this happens; it never injects the error text
into the model's context.

## Private blocks

Wrap anything that must not be persisted:

```text
<private>
do not store this verbatim
</private>
```

Redaction replaces the block with `[REDACTED]` and applies recursively to every outgoing
string. This is a convenience convention, **not** a secret scanner - it will not detect
credentials you did not mark.

## Compaction recovery

When the harness compacts a session, the summary is archived to Engram and the next turn
receives outcome-specific guidance with four possible states:

- **Confirmed** - already saved; no manual action needed.
- **Failed** - a manual `mem_session_summary` fallback is offered.
- **Unknown** (timeout) - the write may have landed; verify with `mem_search` or
  `mem_doctor` before retrying, never blindly.
- **Unavailable** - no trustworthy session or project, so nothing was archived.

## Session identity

The Engram session key is the harness agent id, so a resumed session keeps its binding.
Disposal closes the plugin's own session row, best-effort and without a summary. Engram never
expires a row by itself, so leaving it open would accumulate one row per session the plugin
ever ran - and the doctor's *ambiguous active runtime sessions* check counts exactly those
rows. `mem_session_summary` remains the model's job under the session-close protocol.

If the model does call `mem_session_end`, the next write detects it and starts a **new** Engram
session instead of filing memories under a closed one. Ending is therefore not a dead end: the
closed row keeps its own end time and summary, and work that continues gets a fresh session row.

A row that disappears or is closed behind the plugin's back (`engram delete session`, the CLI)
is handled by the same check, re-run at most once a minute: the row is re-created, or replaced
if it had ended. The plugin does not trust a registration it confirmed an hour ago.

Registration is **lazy**: the row is created by the first thing that actually produces
memory — a `mem_*` write, a captured prompt, a captured tool result, or a compaction
archive — and never by session start. Resolving the project and fetching the injected
context are read-only, so an agent the harness merely publishes (a workspace the GUI
reopened but nobody typed in) leaves no row behind. Reads (`mem_search`,
`mem_context`, `mem_doctor`, …) never create one either. Engram enforces a foreign key
from observations and prompts to the session row, so the row is created and awaited
strictly before the first attributed write; a failed attempt is retried on the next
write rather than being remembered as success.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
```

For development, install by directory (see [Installation](#installation)) so `node_modules`
links to your working tree; the published package would need a reinstall on every change.

### Live reload

With module HMR enabled, `pnpm run build` hot-reloads the running harness — no
restart. Three things about it are non-obvious and cost real debugging time:

1. **The `hmr` row must be enabled at boot.** `dsh-base` ships it
   `disabled: true`, so at boot the launcher creates a config-only fallback
   with `root: []` that then owns the `hmr` service. Enabling the row later
   through a live profile patch cannot add module roots to that instance — it
   takes one restart. `patchReload: live` alone only reloads **config** files.
2. **The build must not clean.** `cordis-plugin-hmr` acts only on `change`
   events (`if (kind !== 'change') return`). A cleaning build deletes `dist/`
   first, so the watcher sees `unlink`+`add` and never reloads. That is why
   `tsdown.config.ts` sets `clean: false`.
3. **A reload gives the plugin a fresh, empty session registry** while agents
   keep running, and no `agent/session-start` fires again. Every tool therefore
   re-initialises its session lazily rather than assuming `agent/session-start`
   already ran — and the prompt/passive capture listeners rebuild the state from
   the agent carried on their own event instead of skipping when it is missing.
   Bailing out there silently disabled all memory capture until the model
   happened to call a `mem_*` tool.

Profile patch:

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - /path/to/dsh-gentle-engram/dist
    ignored:
      - '**/node_modules'
    debounce: 100
```

## License

MIT
