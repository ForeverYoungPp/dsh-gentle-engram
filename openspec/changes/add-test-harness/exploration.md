# Exploration — add-test-harness

Status: complete (exploration notes only; no implementation performed)
Change: `add-test-harness`
Store: openspec — `openspec/changes/add-test-harness/exploration.md`

Evidence base: direct reads of all 12 `src/` modules, `package.json`, `tsconfig.json`,
`tsdown.config.ts`, `.github/workflows/ci.yml`, `.github/workflows/publish.yml`,
`openspec/config.yaml`, `CONTRIBUTING.md`; parent-verified runtime facts (Node v26.9.0,
`node --test` discovers and passes a `.ts` test file, `import('./src/config.ts')` loads
project source directly); gentle-pi SDD assets (`extensions/sdd-init.ts` `renderConfig`,
`assets/agents/sdd-apply.md`, `assets/agents/sdd-verify.md`,
`assets/sdd-orchestrator-workflow.md` §Strict TDD Forwarding, `assets/support/strict-tdd.md`).

## 1. Current testing capability and gaps

- Zero test files (`*.test.*`, `*.spec.*`), no `test` script, no test framework in
  `devDependencies`. Package manager pnpm@10.15.0, ESM (`"type": "module"`), Node v26.9.0
  locally, CI runs `node-version: 22` (latest 22.x).
- `openspec/config.yaml` has `strict_tdd: false`, empty `rules.apply.test_command`,
  `rules.verify.test_command`, `testing.runner.command`, `testing.runner.framework`, and a
  `context:` block stating no reliable test runner was detected.
- `pnpm run typecheck` (tsc, strict, noEmit, include `src/**/*.ts`) and `pnpm run build`
  (tsdown, entry `src/index.ts`) are the only automated checks; CI runs install → audit →
  typecheck → build.
- Capability that exists but is unwired: Node's built-in `node:test` runner needs no
  dependency, and native TypeScript type stripping runs `.ts` tests directly on Node 26 and
  on Node ≥22.18 (default-on type stripping backport). Repo source already uses explicit
  `.ts` import specifiers and no non-erasable syntax (no enum/namespace/decorators/parameter
  properties), so stripping is sufficient — exactly the constraint this makes permanent.
- Gap: no executable RED/GREEN evidence is possible today, so SDD apply/verify cannot be
  gated on strict TDD. The gap is wiring and convention, not tooling capability.

## 2. Module testability classification

| Module | Kind | Seam needed | Suggested order |
|---|---|---|---|
| `src/json.ts` | types only, no runtime code | none — typecheck covers it; no executable test | n/a |
| `src/redaction.ts` | pure (`redactPrivateTags`, `redactUrlPath`, `redactValue`, `redactText`) | none | 1 — pilot/self-proof test |
| `src/protocol.ts` | pure constant provider (`protocolText()`, order/name consts) | none; low-value assertions | low |
| `src/config.ts` | `resolveConfig` pure except `process.env` reads | env save/restore + `warn` spy; node:test runs files in separate processes and file-local tests sequentially, so env mutation is safe | 2 |
| `src/engram/errors.ts` | pure classes/classifiers (`isTimeoutError`, `hasConnectionRefusedCode` cause/aggregate walk, `errorCodeOf`) | none beyond constructing Error/Response-like objects | 2 |
| `src/engram/project.ts` | mixed | `isSafeDetectedProject`/`fallbackProjectName`/`ambiguityGuidance` pure; `detectLocalConfigProject` touches fs (tmp dir fixture); `resolveProject` needs an `EngramClient` stub (interface exists) | 3 |
| `src/capture.ts` | mixed | pure `blocksToText`/`buildRecoveryNotice` first; `warnCapture` needs logger stub; archive/load need `EngramClient` stub | 3 |
| `src/session.ts` | in-memory Map state, promises, timers | logger stub; `drain` uses `Date.now` + unref'd `setTimeout` (real short timeouts or `mock.timers`) | 3 |
| `src/engram/client.ts` | global `fetch`, `AbortSignal.timeout`, backoff `setTimeout` | stub `globalThis.fetch` (`mock.method`); set `fetchMaxAttempts: 1` or `mock.timers` to avoid real backoff delays; `isSafeToReplay` pure | 4 |
| `src/tools.ts` | tool-definition registration + HTTP calls | capture definitions via a fake `register`; stub `ToolRunContext`, `EngramClient`, `SessionRegistry`. Helpers `renderValue`/`queryString` are module-private (test through the tool surface or export later, not for-test-only) | 4 |
| `src/engram/server.ts` | `child_process.spawn`, readiness poll, backoff, recovery generations | hardest: `spawn` is imported directly, so either an injected spawn seam (small production change) or experimental `mock.module('node:child_process')`, which is flag-gated on the CI Node line | 5 — defer or design a seam |
| `src/index.ts` | Cordis plugin wiring (`apply(ctx, rawConfig)`, events, `systemPrompt.inject`, listeners) | fake `PluginContext`; for real behavior use an in-process HTTP stub + `config.url` set (never spawn). Helpers `messageText`/`resultText`/`boundContext`/`contextTextOf` are module-private | 5 — integration-oriented, defer |

Summary: 6 modules (json, redaction, protocol, config, errors + pure halves of project and
capture) are testable immediately with zero seams; session/tools/client need only hand-rolled
stubs for existing interfaces (`EngramClient`, `Logger`, tool `register`); server and index need
a seam decision or deferral. `codegraph`/MCP graph tools were not required — the classification
comes from complete direct source reads.

## 3. Test command surface

- Runner: Node's built-in test runner. Add `"test": "node --test"` to `package.json` scripts;
  canonical command is `pnpm test`. No new dependency; `node:test` + `node:assert/strict` are
  stdlib, `@types/node@^22.20.1` is already present for typechecking `node:test`.
- Focused runs for RED/GREEN: `node --test src/redaction.test.ts` (Node runs the named file
  directly; the strict-TDD support guidance expects focused file runs during apply and the full
  command in verify).
- Location: colocated `src/**/*.test.ts` (`.test.ts` suffix). Rationale:
  - `tsconfig.json` `include: ["src/**/*.ts"]` typechecks colocated tests for free via
    `pnpm run typecheck` — no tsconfig change.
  - tsdown bundles from `entry: ['src/index.ts']` only, so test files are never emitted to
    `dist/`; `files: ["dist", ...]` already excludes `src/` from the published package.
  - Default `node --test` discovery recursively matches `*.test.ts` (parent-verified on this
    Node) and skips `node_modules`; `dist/` currently holds only `index.js`/`index.d.ts`.
  - A top-level `test/` directory was rejected: it would need a tsconfig include change (or a
    second tsconfig) to be typechecked, and Node's `**/test/**` default pattern is not verified
    for `.ts` here.
- Typecheck flow: tests are typechecked by the existing `pnpm run typecheck`; Node type
  stripping does not typecheck, so tests must remain erasable TS (no enum/namespace/parameter
  properties) — the repo already complies.
- Build flow: nothing in `tsdown.config.ts` needs to change. Verify once after the pilot test
  lands that `pnpm run build` still leaves `dist/` at `index.js` + `index.d.ts`.

## 4. Strict TDD switch in openspec/config.yaml

Gate semantics (from gentle-pi assets): the orchestrator forwards
`STRICT TDD MODE IS ACTIVE. Test runner: <command>` to `sdd-apply`/`sdd-verify` only when the
config declares strict TDD **and** a test command. `sdd-apply` then requires a failing test
before production code and a `TDD Cycle Evidence` table in `apply-progress.md`; `sdd-verify`
verifies the table, cross-references test files, re-runs tests, and audits assertion quality
(missing evidence = CRITICAL). `sdd-init` renders `strict_tdd` from the detected test command
alone, so both must be set consistently.

Required edits, mirroring the schema `sdd-init.ts` generates:

```yaml
strict_tdd: true
# context: refresh the "No reliable test runner was detected" line and
# "Unit tests: none." -> node:test via pnpm test; keep the other lines
rules:
  apply:
    test_command: "pnpm test"
  verify:
    test_command: "pnpm test"
testing:
  detected: "<landing date>"
  runner:
    command: "pnpm test"
    framework: "node:test"   # re-running init would restate this as "package script"
  layers:
    unit: "node:test"
  commands:
    unit:
      - scope: "."
        command: "pnpm test"
        framework: "node:test"
```

- `pnpm test` (not bare `node --test`) is the canonical string because `sdd-init`'s
  `scriptCommand` maps a package.json `test` script under pnpm to exactly `pnpm test`; writing
  the same script also makes future re-detection agree (`strict_tdd: true`, framework heuristic
  "package script").
- Keep `testing.coverage`, `quality.lint`, `e2e` empty (no tooling); `quality.typecheck`
  already points at `pnpm run typecheck`.
- This switch is what makes later phases gateable; it cannot itself produce meaningful RED
  (see risk 5).

## 5. Risks and unknowns

1. **CI Node version vs local.** CI pins `node-version: 22` (latest 22.x), local is Node 26.9.0.
   `node --test` with `.ts` discovery requires type stripping enabled by default (Node ≥22.18
   backport; expected to hold on latest 22.x). Must be proven by the CI run; fallback: bump CI
   Node major to match local, or pass explicit test paths. Pair with the missing `engines` field
   (open question: declare `>=22.18`?).
2. **Colocated tests × tsdown.** Low risk: entry-only bundling cannot include unreferenced test
   files, and `clean: false` does not matter. Verify explicitly with one `pnpm run build` after
   the pilot test lands (expect `dist/` unchanged).
3. **`.ts` extension imports under `node:test`.** Parent-verified `import('./src/config.ts')`
   and `.ts` test discovery; repo already imports source with explicit `.ts` specifiers, which is
   exactly what Node type stripping requires. Low risk, no style change needed.
4. **ESM module mocking for `server.ts`.** `mock.module('node:child_process')` is
   experimental/flag-gated on the CI Node line. Prefer an injected `spawn` seam when server tests
   are introduced (later change), or leave server untested until then.
5. **Strict-TDD bootstrap ordering.** Config-only changes (script, CI step, config.yaml) cannot
   have a meaningful pre-implementation RED. Sequence the tasks: runner script + pilot test
   first, switch `strict_tdd` after; record the bootstrap exception explicitly. The first genuine
   RED/GREEN cycle is the first module-suite change.
6. **Zero-test invocation.** If `node --test` finds no files on some Node version it may exit
   non-zero or 0; land the pilot test in the same change as the `test` script so CI is never
   gated on an empty suite.
7. **Test runtime hygiene.** client backoff uses real 250 ms×2^attempt delays; later tests should
   use `fetchMaxAttempts: 1` or `mock.timers`. Not a harness blocker.
8. **Publish gate.** `publish.yml` relies on `prepublishOnly` (typecheck + build) and main-branch
   CI; whether to also gate publish on tests is a small product decision, not required here.

## 6. Scope boundary

Belongs in this change (infrastructure + switch only):

- `package.json`: `"test": "node --test"` script. No dependency changes.
- One pilot/self-proof test file: `src/redaction.test.ts` (pure functions, real edge cases).
  It proves discovery, type stripping, typecheck inclusion, and gives the first genuine
  coverage; the harness otherwise has nothing to run.
- `.github/workflows/ci.yml`: add a `Test` step (`pnpm test`) to the `checks` job.
- `openspec/config.yaml`: strict-TDD switch per section 4 (strict_tdd, apply/verify test
  command, runner, unit layer, context refresh).
- `CONTRIBUTING.md` Validation section: add `pnpm test`; one line documenting the colocated
  `src/**/*.test.ts` + stdlib-only convention.
- Conventions: test files are erasable TS, stdlib `node:test`/`node:assert`, no new deps.

Belongs in later changes (explicitly out of scope):

- Full test suites for the other 11 modules (config, errors, project, capture, session, client,
  tools, server, index, protocol, json) — each is its own follow-up with TDD cycles.
- Shared fakes/fixtures helpers and any production seam refactors (e.g. `spawn` injection for
  server, `fetch` injection for client); decide these when the first client/server tests need
  them, not speculatively.
- Coverage tooling (`--experimental-test-coverage`), watch mode, e2e against a real Engram
  server, CI matrix changes beyond the single test step.
- Exporting module-private helpers (`queryString`, `boundContext`, …) purely for tests.
- `prepublishOnly` test gating and `engines` declaration (optional decisions; see risks 1/8).

Review-budget note: the in-scope change is roughly 40–80 authored lines, well under the
400-line budget; no `size:exception` or chaining decision is expected.

## 7. Open questions for the proposal/question round

1. Pilot test content: redaction only (recommended, pure and real), or also a trivial protocol
   assertion to prove a second file runs?
2. Should `prepublishOnly` include `pnpm test`, or is the CI `checks` job the only gate?
3. Declare `engines.node: ">=22.18"` now, or only if the CI Node-22 run fails?
