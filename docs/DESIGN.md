# Design record — dsh-gentle-engram

Status: applies to 0.2.0 and later. Implemented.

This is a **decision record, not a specification**. Behaviour lives in `src/`, and
the reason for each mechanism lives in the module comment at the point of use —
the server lifecycle, the per-session state map, the deferred registration, the
fail-closed project gate, the four-way archive outcome, the tool surface. What
follows is only what those comments cannot carry: why the rewrite happened at
all, which decision was contested, which invariants must keep holding, and what
is knowingly left undone.

## 1. Why 0.2.0 exists

Version 0.1.x bridged Engram's MCP server. Two capabilities this plugin needs
are structurally absent from that surface:

| Capability | Why MCP cannot provide it |
| --- | --- |
| Resolve a project from the session's working directory | The MCP project lookup reads the MCP child process's own working directory and accepts no `cwd` argument. DSH is a multi-session host, so that answer belongs to the wrong session. |
| Detect project ambiguity for a given directory | The HTTP route takes a `cwd`; the MCP surface does not. |

A third point is a correction rather than a reason. The Pi adapter sets
`directTools: false`, which reads like "the upstream deliberately disabled MCP".
It is that adapter's default, and it means *proxy only* — the MCP tools stay
reachable through a single proxy tool. So going HTTP-native is this project's
product decision, not an argument borrowed from upstream.

## 2. The decision, and the dissent against it

Decision: **all Engram access goes over HTTP.** The bundle patch inserts no MCP
row, and the plugin registers its own tool surface.

The adversarial review that ran before implementation recommended the opposite:
keep the existing MCP tool surface, and use HTTP only for lifecycle and reads. It
argued that rewriting 18 tools was the largest and least load-bearing part of the
work, and that it was what dragged the `engram serve` lifecycle dependency in.
That recommendation was overridden deliberately.

This is recorded so the trade-off is not re-litigated. If the tool surface is ever
revisited, it is a product question, not a defect in this document.

### Follow-up decision: recall is pull-based

Decision: the plugin injects **no project memory**. The system-prompt contributor
carries the static protocol plus the one-shot post-compaction notice; everything
else the model pulls on demand with `mem_context` / `mem_search`, exactly as the
reference Pi adapter does.

The standing ambient block and the warm-up fetch that fed it were removed for two
reasons:

- It cost a per-session context block that Engram does not size-contract, so the
  plugin had to ship a truncation knob to contain it.
- An injected block reads as *this session's* context, so a mis-resolved project
  would make another project's memories look recallable here — the cross-project
  leak the project-scoping work exists to prevent.

User-visible consequence, accepted deliberately: a new session starts with no
memory in context until the model calls `mem_context`.

## 3. Invariants

Each of these has a matching comment in the code. They must keep holding.

- **Fail closed on projects.** No write happens without a resolved project, and a
  `200` carrying `error_hint` counts as a failure rather than a detection. Guessing
  would file memory under the wrong project.
- **A project never comes from the server's directory.** Every request that carries
  a project takes it from the session's own resolution, or from a caller's explicit
  `project` argument on a read tool — never from the working directory of the
  `engram serve` process. An unresolved project fails closed rather than being
  guessed.
- **One writer per store.** Every read and write goes through HTTP, so only
  `engram serve` touches the SQLite file. There is no second resolution path.
- **The server is this machine's own Engram instance.** Before attaching, the
  plugin compares the answering server's `/health` `instance_id` against
  `engram instance-id`, and a mismatch — or a missing, unreadable identity — is
  refused rather than adopted: a process that merely holds the port is not ours
  to trust. `ENGRAM_URL` is the explicit opt-out, and an explicitly chosen
  server is used as given, with no identity check.
- **Session identity is the agent id.** A resumed session keeps its Engram
  binding; a fresh key is minted only once the current row has ended.
- **Registration is deferred to the first write.** Reading memory must not leave a
  session row behind: Engram injects a fixed five-slot recent-sessions block, and
  rows belonging to agents that never produced memory crowd out real sessions.
- **A failed project resolution expires.** A resolved project is final for the
  session; a failure is retried after 30s, so adding `.engram/config.json` to an
  ambiguous workspace takes effect without a restart.
- **A session row ends in exactly two places.** `mem_session_end`, when the model
  says the work is over, and `agent/disposed`, which closes this plugin's own row
  best-effort. Engram never expires a row by itself, so without the second path an
  open row accumulates per run — and the doctor's *ambiguous active runtime
  sessions* check counts precisely those rows, which makes every CLI write that
  omits a session id fail closed. Only this plugin's own row is ever closed.
  Ending is one-way: Engram's create route does not clear `ended_at`, so a session
  that is used again gets a new key rather than reopening the old row.
- **One write queue per session**, with the close queued behind it so that nothing
  lands after the row ends.
- **Redaction is explicit `<private>` blocks only**, applied recursively to every
  outbound string and URL query value. It is a convention, not a secret scanner:
  regex-guessing credentials was tried in 0.1.x and both missed real secrets and
  discarded useful code.

## 4. Non-goals

No hardcoded session summary. No regex secret scanning. No dual MCP + HTTP
transport. No unix-socket transport yet. `mem_list_projects` stays unexposed
because its handler calls the store directly and Engram serves no HTTP route for
it. `mem_delete` was unexposed on the nominal grounds that its route sits behind
`requireAuth`, but that reason was misread: with `ENGRAM_HTTP_TOKEN` unset the
check passes through and the route was open all along, so the only real blocker
was the missing `Authorization` header — and with the variable set, the delete
route is the one operation that needs it. The transport now sends
`Authorization: Bearer` when that variable is set, and the tool is exposed on the
same footing as the rest. And never silently guess which project a workspace
belongs to — that one is a safety property, not a preference.

## 5. Known residuals

- **A hard process exit can drop the close request.** DSH does not await
  `agent/disposed` listeners, and Cordis dispose is single-shot, so no plugin-side
  hook can flush a pending request. The close is therefore best-effort: an abrupt
  kill can leave one row open. Nothing is lost — the memory was written earlier —
  the row simply stays counted until it ages out of the check's activity window.
- **A resume racing the queued close at sub-second granularity cannot be
  reproduced by hand.** The guard that prevents it is covered by an
  independent-process harness with a negative control, and the DSH contract that
  fires the relevant event is verified in DSH's source. If the guard ever loses the
  race, the outcome is a session-key rotation, not lost memory.
- **The closing marker is process-local**, so a hot reload clears it. The agent-id
  fallback still covers the common case, where the key never rotated.

## 6. Verification status

Exercised end to end: real compaction archiving and its four-way outcome
guidance, binding across a restart, hot reload, read/write round trip, prompt
end-then-rotate, the close on disposal, a cold start that spawns its own server,
and the three `timers/promises` sleeps on their real call paths.

Not exercised: a real DSH resume, because DSH does not expose that operation, and
the sub-second ordering described above.

Contracts were verified against the DSH source tree and against Engram's HTTP
routes and store behaviour. Both move, so this record cites behaviours rather than
file positions — an earlier draft carried a line-number index, and it went stale.
