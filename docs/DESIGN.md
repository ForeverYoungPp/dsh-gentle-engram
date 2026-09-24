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
- **Session identity is the agent id, and it survives resume.** The Engram key is
  the harness agent id for the session's whole life, across `resume` and a plugin
  reload, so one DSH session keeps one Engram row. It is replaced only when Engram
  proves the key is unusable: `409 session_already_ended` (an ended row is terminal
  and can never be reopened) or `409 session_project_conflict` (a `project_owned`
  row is pinned to its project). Both rotate once and retry.
- **Liveness is Engram's runtime lease, not `ended_at`.** `POST /sessions` is
  create-or-renew and every write refreshes the 30-minute lease the server keeps
  on the row. A lapsed lease does not end or invalidate anything - it only stops
  the row from being offered as a live candidate when another writer omits a
  session id - and the next write renews it. Disposal therefore writes nothing.
- **Registration is deferred to the first write.** Reading memory must not leave a
  session row behind: Engram injects a fixed five-slot recent-sessions block, and
  rows belonging to agents that never produced memory crowd out real sessions.
- **A failed project resolution expires.** A resolved project is final for the
  session; a failure is retried after 30s, so adding `.engram/config.json` to an
  ambiguous workspace takes effect without a restart.
- **A session row ends in exactly one place.** `mem_session_end`, when the model or
  the user says the work is over. `agent/disposed` deliberately does **not** end the
  row: `ended_at` is terminal in Engram, so ending there would destroy the binding a
  resumed session needs under the same agent id, and the lease already bounds the
  row's life as a resolution candidate. Ending is one-way, so a session that
  produces memory after an explicit end gets a new key rather than reopening the old
  row. Only this plugin's own row is ever ended.
- **One write queue per session.** Work already queued when an agent is disposed
  keeps its own reference to the session state, so it still lands; disposal only
  drops the map entry.
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

- **The row is never ended by the plugin, so it stays `ended_at IS NULL`.** Engram
  drops a row from omitted-session resolution as soon as its 30-minute lease
  lapses — the legacy activity window applies only to rows that carry no lease at
  all — so an abandoned row stops being a resolution candidate on its own. It
  remains in listings without an end time, which is the deliberate trade for
  keeping a resumed session on its own row.
- **A key that had to rotate is not recoverable after a reload.** Rotation is
  process-local state, so a session that ended explicitly (or changed project) and
  is then reloaded starts from the agent id again, finds that row ended, and mints
  another key. The session's observations stay recallable by project; only the
  session grouping splits across two rows.
- **A hard process exit writes nothing**, which is now the intended behaviour
  rather than a dropped close: there is no close to drop.
- **The registration TTL is a 60s window.** A row ended behind the plugin's back
  can still receive a write for up to a minute. Engram accepts writes to an ended
  row, so the memory lands under the session that just ended rather than being
  rejected; the next renewal detects it and rotates. Narrowing the window would
  mean a registration round trip per write.

## 6. Verification status

Exercised end to end: real compaction archiving and its four-way outcome
guidance, binding across a restart, hot reload, read/write round trip, prompt
end-then-rotate, session registration and its two rotation cases, disposal
writing nothing, a resume keeping the key, a cold start that spawns its own
server, and the three `timers/promises` sleeps on their real call paths.

Not exercised: a real DSH resume, because DSH does not expose that operation; the
subscribe-level resume path is covered by driving the plugin's own event
listeners against a stubbed server instead. The sub-second disposal/resume
ordering is covered at the state level (a released state never registers), not by
racing a real resume.

Contracts were verified against the DSH source tree and against Engram's HTTP
routes and store behaviour. Both move, so this record cites behaviours rather than
file positions — an earlier draft carried a line-number index, and it went stale.
