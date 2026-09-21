# Design — add-test-harness

Status: design
Change: `add-test-harness`
Store: openspec — `openspec/changes/add-test-harness/design.md`
Spec: `openspec/changes/add-test-harness/specs/testing/spec.md` (8 requirements, 14 scenarios)
Review size: ~40–80 authored lines of product change; under the 400-line budget — no `size:exception`, no chaining.

## Design in one paragraph

Wire Node's stdlib runner into the project with one package script, land one colocated
pilot test that exercises all four `src/redaction.ts` functions, gate CI with a `Test`
step between `Typecheck` and `Build`, and flip `openspec/config.yaml` to strict TDD
**last**. Zero production code, zero dependencies, no `tsconfig.json` / `tsdown.config.ts`
change. The two non-obvious mechanics are the bootstrap ordering (the strict-TDD flip is
the final commit) and the negative control (a one-assertion inversion whose exact command
and output are recorded).

## Decisions

Each decision below is settled; the rejected alternative is recorded because
`rules.design.require_tradeoffs: true`.

| # | Decision | Rejected alternative | Why the alternative was rejected |
|---|---|---|---|
| D1 | Runner: Node stdlib `node:test`, script `"test": "node --test"`, canonical command `pnpm test` | Vitest, or Jest | Node ≥ 22.18 already strips types and discovers `.ts` tests (verified on Node 26.9.0 locally). Vitest/Jest add a dependency, a config file, and a second transform pipeline to retest code that already has a typechecker. Stdlib costs one line. |
| D2 | Test files colocated at `src/**/*.test.ts` | Top-level `test/` directory | `tsconfig.json` `include: ["src/**/*.ts"]` typechecks colocated tests with no config change; a `test/` dir needs a tsconfig edit or a second tsconfig, and Node's `**/test/**` default pattern is unverified for `.ts` on the CI Node line. Colocation also keeps the test next to the module it covers. |
| D3 | Declare `package.json` `engines.node: ">=22.18"` | Omit `engines`; or declare a higher floor such as `>=26` | 22.18 is exactly the first release where type stripping is on by default, i.e. the true minimum that can run the harness. Omitting it leaves contributors guessing; a `>=26` floor would falsely exclude the Node 22 line CI itself uses. |
| D4 | CI stays on `node-version: 22` | Bump CI to match local Node 26 | The local pass is not evidence about the CI line; bumping first would hide the discovery question instead of answering it, and a CI major bump is a delivery decision the user owns. Keeping 22 also keeps the declared `engines` floor honest. |
| D5 | Strict-TDD flip is the **last** task/commit | Set `strict_tdd: true` first, or in the same commit as the script | A config-first flip makes this change violate its own gate (see *Bootstrap ordering*): no production code exists to make RED, and `pnpm test` does not yet exist so its failure is a config error, not a failing test. The spec's bootstrap scenario also requires the first strict-TDD commit to already contain the script and the pilot test. |
| D6 | Negative control: deliberately invert one assertion, run the suite, record command + output in `apply-progress.md`, revert | Assert in prose that the harness works; or add a permanent `assert.fail()`-style "canary" test | The gate must be proven able to fail, and the transcript must be reproducible after the fact. A permanent canary test would make every future run red or need `skip`, and prose cannot be re-derived by verify. |
| D7 | Publish gate unchanged: `prepublishOnly` stays `pnpm run typecheck && pnpm run build` | Add `pnpm test` to `prepublishOnly` | Release publishing already runs on `main`, which is covered by the CI `Test` step. Changing the publish path is a separate product decision, not part of establishing the harness (proposal risk 6). |

Deferred, not rejected — belongs to later changes: suites for the other 11 modules, shared
fakes/fixtures, production seam refactors (`spawn`/`fetch` injection), coverage tooling,
watch mode, real-Engram e2e, `--test-reporter` polish.

## How the pieces connect

```text
pnpm test  ->  package.json: "test": "node --test"
           ->  Node discovery of src/**/*.test.ts (skip node_modules)
           ->  type stripping executes erasable TS (needs Node >= 22.18)
           ->  node:assert/strict assertions
           ->  exit 0 | non-zero
CI: checks job -> ... -> Typecheck -> Test (pnpm test, fails the job) -> Build
openspec gate -> strict_tdd + rules.{apply,verify}.test_command  ->  orchestrator injects STRICT TDD MODE
typecheck path -> tsc include src/**/*.ts  (covers tests, no config change)
build path    -> tsdown entry src/index.ts only  (tests never emitted; files[] excludes src/)
```

## File changes and exact commit plan

| File | Change | Commit (work unit) |
|---|---|---|
| `package.json` | `"test": "node --test"`; `engines.node: ">=22.18"` | 1 |
| `src/redaction.test.ts` | New pilot test — all four exports, edge cases, `node:test` + `node:assert/strict` | 1 |
| `openspec/changes/add-test-harness/exploration.md` | Planning record, already on disk and untracked | 1 |
| `openspec/changes/add-test-harness/proposal.md` | Planning record, already on disk and untracked | 1 |
| `openspec/changes/add-test-harness/design.md` | This file; already on disk and untracked | 1 |
| `openspec/changes/add-test-harness/tasks.md` | Written by `sdd-tasks` immediately before apply | 1 |
| `openspec/changes/add-test-harness/specs/testing/spec.md` | Spec delta, already on disk and untracked | 1 |
| `openspec/changes/add-test-harness/apply-progress.md` | Bootstrap exception, negative-control transcript, per-unit evidence | 1, 2, 3 (re-staged at each append) |
| `.pi-lens.json` | `{ "ignore": ["dist/**"] }` — repo-local tooling config already in the tree; assigned here (it is not a spec requirement) so no stray untracked path survives | 1 |
| `.github/workflows/ci.yml` | `Test` step (`pnpm test`) after `Typecheck`, before `Build` | 2 |
| `CONTRIBUTING.md` | Validation section: `pnpm test` + convention line | 2 |
| `openspec/config.yaml` | Target state: strict-TDD switch + `context` refresh | 3 (last) |

The planning artifacts add review context but zero product change; the ~40–80
authored-line budget counts `package.json`, `src/redaction.test.ts`,
`.github/workflows/ci.yml`, `CONTRIBUTING.md`, and `openspec/config.yaml`.

Three commits, created in order by `sdd-apply`; each stages an explicit path
list. `git add -A`, `git add .`, and `git add openspec/` are forbidden — the last
would sweep `config.yaml`, all five planning artifacts, and `archive/` into
whichever commit touches it and collapse the intended split. `.pi/` is excluded
from every commit.

**Commit 1 — `test: add Node stdlib test harness with pilot redaction test`**

```bash
git add -- package.json src/redaction.test.ts .pi-lens.json \
  openspec/changes/add-test-harness/exploration.md \
  openspec/changes/add-test-harness/proposal.md \
  openspec/changes/add-test-harness/design.md \
  openspec/changes/add-test-harness/tasks.md \
  openspec/changes/add-test-harness/specs/testing/spec.md \
  openspec/changes/add-test-harness/apply-progress.md
git commit -m "test: add Node stdlib test harness with pilot redaction test"
```

Preconditions: pilot test green, negative control executed and reverted (the
file must be green *before* it is staged), work-unit-1 evidence written to
`apply-progress.md`. Still untracked after this commit: `openspec/config.yaml`.

**Commit 2 — `ci: gate checks on pnpm test and document the test contract`**

```bash
git add -- .github/workflows/ci.yml CONTRIBUTING.md \
  openspec/changes/add-test-harness/apply-progress.md
git commit -m "ci: gate checks on pnpm test and document the test contract"
```

**Commit 3 — `chore(openspec): enable strict TDD now that the harness is green` (last)**

```bash
git add -- openspec/config.yaml openspec/changes/add-test-harness/apply-progress.md
git commit -m "chore(openspec): enable strict TDD now that the harness is green"
```

Commit 3 is the first commit that sets `strict_tdd: true`, and it is created only
after the harness is green; its ancestors already carry `"test": "node --test"`
and `src/redaction.test.ts`, which is exactly what the spec's ordering scenario
inspects. Keeping it last is what makes `git show <commit>:package.json` /
`git show <commit>:src/redaction.test.ts` pass on the unmodified repo history.

### End state

After commit 3, this prints exactly one line:

```bash
git status --short   # ?? .pi/
```

- **`.pi/` is deliberately left uncommitted** — `gentle-ai/sdd-preflight.json`
is session/machine-local harness state, and `CONTRIBUTING.md` forbids
machine-specific configuration in a commit. It is the only untracked path.
- `openspec/changes/archive/` and `openspec/specs/` are empty directories: git
cannot track them, they never appear in `git status`, and no `.gitkeep` is added
(out of scope).
- `dist/` must show no diff after the `pnpm run build` check — the output is
byte-identical, so that check leaves the tree clean.
- Nothing is appended after commit 3. A commit cannot record its own SHA, so the
commit SHAs and the rung-0 CI log are reported by apply/delivery and re-derived
by verify with read-only commands (`git log`, `git show`) rather than written
into a tracked file post-commit.

## Contracts

| Contract | Definition |
|---|---|
| Canonical command | `pnpm test`. Used verbatim in `package.json`, CI, `CONTRIBUTING.md`, and all three config fields. `node --test` is the script body only. |
| Focused command (apply/RED turns) | `node --test src/redaction.test.ts` — same runner, one file, tight transcript. |
| Exit-code contract | Non-zero if any test fails. `pnpm test` must never be wrapped with `\|\| true`, conditionals, or `continue-on-error`. |
| Discovery contract | Script and pilot test land together, so the gate is never pointed at an empty suite (empty-suite exit status is not trustworthy across Node 22.x patch releases). |
| Style contract | Test files are erasable TypeScript (no `enum`, `namespace`, parameter properties) and stdlib-only (`node:test`, `node:assert`) — permanent, documented in `CONTRIBUTING.md`. |
| Config contract | `strict_tdd: true` and non-empty `apply`/`verify` `test_command` together are what make the orchestrator inject `STRICT TDD MODE IS ACTIVE`. |
| Pilot content contract | One test file, four `test(...)` cases minimum (one per function), ≥ 1 edge case each: multiple/case-insensitive/multiline private blocks; private value in a query string with pathname + query structure preserved; nested objects/arrays through `redactValue` with non-string primitives unchanged; whitespace + private tag through `redactText`. No tautologies, no assertion-free tests. |

## Operational mechanics

### Bootstrap ordering: why config-first is unsatisfiable

Three independent reasons, any one sufficient:

1. **No RED unit exists.** Once `strict_tdd: true` and `test_command` are set, the
   orchestrator forwards STRICT TDD MODE to `sdd-apply`, which requires a failing test
   before production code. This change adds no production code — only a script, a test
   file, a CI step, and config/docs. There is nothing to make RED.
2. **A missing script is not a failing test.** Before the harness lands, `pnpm test`
   fails as "no such script" — a configuration error, not an observed assertion failure,
   so it cannot satisfy a RED requirement.
3. **The spec makes the ordering checkable.** The bootstrap scenario inspects the first
   commit that sets `strict_tdd: true` and requires that commit to already contain
   `"test": "node --test"` and `src/redaction.test.ts`. A config-first commit fails an
   acceptance criterion of this very change; it is self-contradicting, not merely awkward.

**Recording** (in `openspec/changes/add-test-harness/apply-progress.md`, written by
`sdd-apply`):

```markdown
## Bootstrap exception (strict TDD)
- Ordering: runner script + pilot test landed in commit <SHA-A>; strict_tdd flipped in <SHA-C> (last).
- Why: a config-first flip would make this change unsatisfiable under its own gate —
  no production code exists to make RED, and a missing script is a config error, not a failing test.
- Substitute gate evidence for this change: the negative control below (one inverted
  assertion, non-zero observed), plus green `pnpm test`.
- First genuine RED/GREEN cycle: the first module-suite follow-up change.
```

Because `strict_tdd` is still `false` while `sdd-apply` runs, no STRICT TDD MODE is
injected during this change; the exception is a declaration to `sdd-verify`, not a
request for leniency. `sdd-apply` must still include a `TDD Cycle Evidence` section
stating "no RED/GREEN cycle — bootstrap exception, see above", so verify does not mark
missing evidence CRITICAL.

### CI Node-22 contingency ladder

Run the rungs in order. Never skip down, never loosen the gate.

| Rung | Action | Discharged by | Consent? |
|---|---|---|---|
| 0 (primary) | Ship as designed: script `node --test`, CI yes step `run: pnpm test` | The first CI run on the change (PR or `main` push): the `Test` step conclusion is `success` **and** the step log names `src/redaction.test.ts` with pass counts. Recorded once the branch is pushed — workflow run URL/id, commit SHA, step name, conclusion, log excerpt — in the change's report artifacts and PR body; never as an edit to a tracked file after commit 3, which would dirty the tree. | No |
| 1 | Default discovery fails on Node 22: make the failure explicit-path instead — set `"test": "node --test src/redaction.test.ts"` (preferred) or the CI step's `run` to the same explicit path. CI step, `rules.*.test_command`, and `CONTRIBUTING.md` keep `pnpm test` valid because the path moves into the script. | A CI log showing the explicit-path command exiting 0 and naming the test file. | No (the proposal pre-authorizes this fallback) — but it contradicts the spec's literal `"test": "node --test"` AC, so the spec text must be amended in the same change and the amendment noted in `apply-progress.md`. |
| 2 | Only if rung 1 also fails: bump CI `node-version` to a major where discovery is verified (e.g. 24 or 26). | Explicit user consent for the target version, recorded verbatim in `apply-progress.md`, plus a green CI `Test` step afterwards. | **Yes — ask-on-risk delivery decision. Pause and ask; never edit CI silently.** |
| Abort | If rung 2 is not approved or also fails: stop, report blocked, keep the change unmerged. | — | — |

`engines.node: ">=22.18"` is unchanged at every rung. Forbidden at every rung:
`continue-on-error`, `|| true`, removing the `Test` step, `skip`-ing the pilot test, or
reverting `strict_tdd` to make the gate disappear. Known ceiling of rung 1: the explicit
path does not grow as suites land, so it needs a follow-up (rung 2, or a Node line where
discovery is verified) — mark it in `apply-progress.md`.

### Negative control: execution and recording

Executed and recorded by `sdd-apply` in work unit 1, after the pilot test is green
and before commit 1 — the file must be green again before it is staged:

1. Pick the highest-leverage single assertion — the multiple-private-blocks case for
   `redactPrivateTags` (`'a <private>x</private> b <private>y</private> c'`).
   Invert it meaningfully by changing the expected literal to the unredacted input, not by
   inserting `assert.fail(...)`.
2. Focused run, capture transcript: `node --test src/redaction.test.ts` → non-zero.
3. Canonical run: `pnpm test` → non-zero.
4. Revert the one line to the recorded original; re-run both commands → exit 0.
5. Record verbatim in `apply-progress.md`:

```markdown
## Negative control (proves the harness can fail)
Command: pnpm test            (focused: node --test src/redaction.test.ts)
File/line: src/redaction.test.ts:<line>
Original assertion: <exact source line>
Inverted assertion: <exact source line>
Observed (inverted): exit <code> — <failing test name> — AssertionError: <pasted lines>
Observed (reverted): exit 0 — pass <n>, fail 0
Final-tree check: <inverted fragment> absent from src/redaction.test.ts
```

Reproducibility rules: both source lines verbatim (so verify can re-apply and re-observe);
the command exactly as run with exit codes; the failing test name plus the assertion diff
lines pasted, not summarized; the inverted state must **not** be committed and must not be
present in the final tree (the last recorded run is the green one). Limit to state: this
proves `node --test` reports failure for a broken assertion; CI *job* failure on a red
suite is covered by rung 0's `Test` conclusion plus the step's position between
`Typecheck` and `Build`.

### Exact `openspec/config.yaml` edits

| Field | Current | Target |
|---|---|---|
| `strict_tdd` | `false` | `true` (set in commit 3, last) |
| `context` line "No reliable test runner was detected; verify testing manually before enabling strict TDD." | present | Replace: unit tests run on the Node built-in `node:test` runner via `pnpm test` (no dependencies). |
| `context` line "Unit tests: none." | present | Replace: unit tests — `node:test` via `pnpm test`, colocated at `src/**/*.test.ts`. |
| `context` lines 1–3 (project, markers, package managers), "Integration tests: none.", "E2E tests: none." | — | Unchanged |
| `rules.apply.test_command` | `""` | `"pnpm test"` |
| `rules.verify.test_command` | `""` | `"pnpm test"` |
| `testing.runner.command` | `""` | `"pnpm test"` |
| `testing.runner.framework` | `""` | `"node:test"` (literal stdlib name, so re-running `sdd-init`'s heuristic cannot silently restate it as "package script") |
| `testing.layers.unit` | `""` | `"node:test"` |
| `testing.commands.unit` | `[]` | exactly one entry: `scope: "."`, `command: "pnpm test"`, `framework: "node:test"` |
| `testing.detected` | `"2026-09-21"` | Optional consistency refresh to the landing date — **not** an acceptance criterion |
| `testing.coverage`, `testing.layers.integration`/`e2e`, `testing.commands.integration`/`e2e`, `quality.lint`, `quality.format` | empty | Stay empty |
| `quality.typecheck*`, `rules.proposal`/`spec`/`design`/`tasks` | — | Unchanged |

Resulting block (abridged):

```yaml
strict_tdd: true
context: |
  ...
  Unit tests: node:test via pnpm test (colocated src/**/*.test.ts; stdlib only, no dependencies).
rules:
  apply:
    test_command: "pnpm test"
  verify:
    test_command: "pnpm test"
testing:
  runner:
    command: "pnpm test"
    framework: "node:test"
  layers:
    unit: "node:test"
  commands:
    unit:
      - scope: "."
        command: "pnpm test"
        framework: "node:test"
```

### What `sdd-apply` must produce for `sdd-verify`

Verify must be able to discharge all 14 scenarios from the artifacts alone; no parent
lookup. Apply produces:

| Spec requirement | Evidence apply must produce | Where |
|---|---|---|
| Zero-Dependency Test Runner | `git diff package.json` showing only `scripts.test` + `engines`; `pnpm test` transcript with exit 0 and `src/redaction.test.ts` in the output; `prepublishOnly` line quoted | `apply-progress.md` + repo diff |
| Colocated convention | `pnpm run typecheck` exit 0; `git diff`/`git status` showing `tsconfig.json` and `tsdown.config.ts` untouched; `pnpm run build` exit 0 plus the output of listing `dist/` (`index.js`, `index.d.ts` only) | `apply-progress.md` |
| Runtime floor | `package.json` read (`engines.node` exactly `>=22.18`, no other `engines` key) | repo diff |
| CI Test Gate | `ci.yml` diff with the `Test` step and its position; `node-version: 22` quoted; local `pnpm test` transcript; rung-0 CI evidence (run URL/id, commit SHA, step conclusion, log excerpt naming `src/redaction.test.ts`), captured once the branch is pushed | repo diff + `apply-progress.md` + PR/verify report for the CI run |
| Strict-TDD config & bootstrap | `config.yaml` diff; the bootstrap-exception block; work-unit commit SHAs with commit 3 last (commit 3's own SHA comes from apply's report — a commit cannot record its own id); `git show <SHA-C>:package.json` / `git show <SHA-C>:src/redaction.test.ts`, which verify re-runs read-only | repo diff + `apply-progress.md` + apply report |
| Pilot coverage | `src/redaction.test.ts` content (four function names, edge cases) + green transcript | repo + `apply-progress.md` |
| Gate negative control | The recorded block above, verbatim, including the reverted-state green run | `apply-progress.md` |
| Contributor contract | `CONTRIBUTING.md` diff showing `pnpm test` next to typecheck/build and the convention line | repo diff |

Apply must also leave: `git status --short` printing exactly `?? .pi/` after commit 3,
no inverted assertion in the tree, no dependency-section change, and a `TDD Cycle
Evidence` section carrying the bootstrap exception (no RED/GREEN cycle this change).

## Rollback

All edits are additive and local; the runtime artifact (`dist/index.js`, `dist/index.d.ts`)
is byte-identical after this change, so there is no runtime, data, or published-package
blast radius.

| Step | Action | Note |
|---|---|---|
| 1 | Revert the strict-TDD commit (commit 3) first | While `test_command` is still `pnpm test` and `scripts.test` exists, config and script agree; removing the script before the config flip would leave a dangling `test_command` |
| 2 | Revert the CI + `CONTRIBUTING.md` commit | CI loses the `Test` step; docs stop advertising the harness |
| 3 | Revert the runner + pilot-test commit, delete `openspec/changes/add-test-harness/apply-progress.md` evidence references if the whole change is abandoned | `pnpm test` disappears; `engines` removed. Commit 1 also carries the planning artifacts and `.pi-lens.json`: on full abandonment keep or archive the planning record rather than reverting it away |
| 4 | Verify | `git status` shows only `?? .pi/`; `pnpm run typecheck` and `pnpm run build` still pass; `dist/` unchanged |

`git revert` of the whole change in one go is equivalent; the order above only matters for
a partial revert. Precondition for re-landing: the same three commits, same order.
Only observable effect of rollback: strict TDD is unavailable again.

## Review checklist

- [ ] `pnpm test` green and its output names `src/redaction.test.ts`.
- [ ] Negative-control transcript present with original + inverted lines, exit codes, pasted output.
- [ ] `package.json` diff is only `scripts.test` + `engines`; `prepublishOnly` untouched.
- [ ] `tsconfig.json`, `tsdown.config.ts`, `files`, dependency sections unchanged.
- [ ] `dist/` still `index.js` + `index.d.ts`.
- [ ] Commit 3 is the first commit containing `strict_tdd: true`, and it already contains the script and the pilot test.
- [ ] CI `Test` step between `Typecheck` and `Build`; `node-version: 22`; first-run evidence recorded.
- [ ] `config.yaml` fields match the target table; `coverage`/`lint`/`e2e` still empty.
- [ ] After commit 3, `git status --short` prints exactly `?? .pi/`; no planning artifact is left untracked.
- [ ] `.pi-lens.json` is committed in commit 1; `.pi/` appears in none of the three commits.

## Out of scope (scope guard)

Suites for the other 11 modules, shared fixtures/fakes, production seam refactors
(`spawn`/`fetch` injection), coverage tooling, watch mode, real-Engram e2e, exporting
module-private helpers for tests, `prepublishOnly` gating, and any
`tsconfig.json` / `tsdown.config.ts` change.
