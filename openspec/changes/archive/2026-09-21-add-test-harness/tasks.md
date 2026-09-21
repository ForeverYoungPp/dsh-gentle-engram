# Tasks — add-test-harness

Status: tasks
Change: `add-test-harness`
Store: openspec — `openspec/changes/add-test-harness/tasks.md`
Spec: `openspec/changes/add-test-harness/specs/testing/spec.md` (8 requirements, 14 scenarios)
Design: `openspec/changes/add-test-harness/design.md` (authoritative for commit boundaries, contracts, and the CI contingency ladder)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~40–80 authored product lines (5 product files) + planning artifacts |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR (three work-unit commits inside it) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

```text
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low
```

Basis: the design's file plan touches 5 product files — `package.json` (~5 lines),
`src/redaction.test.ts` (~30–50), `.github/workflows/ci.yml` (~3), `CONTRIBUTING.md` (~4),
`openspec/config.yaml` (~15) — totaling ~40–80 authored lines, an order of magnitude under
the 400-line budget. No dependencies, no migrations, no generated artifacts, and `dist/`
stays byte-identical. No `size:exception` and no chaining are needed, so no decision is
required before apply; commit 3 is additionally forced to be last by the bootstrap
constraint in the design, not by size.

Note: this `tasks.md` is itself staged in **commit 1** (per the design's commit plan), so it
is present in the tree before the pilot test is committed.

## Commit plan (hard ordering — do not collapse)

Three work-unit commits, created in order. Each stages an explicit path list; `git add -A`,
`git add .`, and `git add openspec/` are forbidden, and `.pi/` is excluded from every commit.

1. `test: add Node stdlib test harness with pilot redaction test` — `package.json`,
   `src/redaction.test.ts`, `.pi-lens.json`, plus the untracked planning artifacts
   (`exploration.md`, `proposal.md`, `design.md`, `tasks.md`, `specs/testing/spec.md`,
   `apply-progress.md`).
2. `ci: gate checks on pnpm test and document the test contract` — `.github/workflows/ci.yml`,
   `CONTRIBUTING.md`, `apply-progress.md`.
3. `chore(openspec): enable strict TDD now that the harness is green` — **last**
   `openspec/config.yaml`, `apply-progress.md`.

## Tasks

### Commit 1 — Node stdlib harness + pilot redaction test

- [x] 1.1 In `package.json`, add `"test": "node --test"` to `scripts` and `"engines": { "node": ">=22.18" }` as a top-level key; leave `dependencies`, `devDependencies`, `peerDependencies`, `files`, and `prepublishOnly` byte-identical. Verify with `git diff package.json` showing only `scripts.test` and `engines`. (Requirement: Zero-Dependency Test Runner; Declared Node Runtime Floor)
- [x] 1.2 Create `src/redaction.test.ts` importing all four exports from `./redaction.ts` and using only `node:test` + `node:assert/strict`, with at least four `test(...)` cases (one per function) and ≥ 1 edge case each: multiple/case-insensitive/multiline private blocks in `redactPrivateTags`; a private value in a percent-encoded query value with pathname + query structure preserved in `redactUrlPath`; nested objects/arrays plus unchanged non-string primitives in `redactValue`; whitespace + private tag in `redactText`. Erasable TypeScript only — no `enum`, `namespace`, or parameter properties; no tautologies or assertion-free tests. (Requirement: Pilot Redaction Coverage; Colocated `src/**/*.test.ts` Test Convention)
- [x] 1.3 Run `node --test src/redaction.test.ts` and capture the transcript showing exit 0 with all four cases passing; if the run fails, fix the test (never the gate) and re-run. (Requirement: Pilot Redaction Coverage)
- [x] 1.4 Execute the **negative control** as its own step: invert the highest-leverage assertion — the multiple-private-blocks case for `redactPrivateTags` (`'a <private>x</private> b <private>y</private> c'`) — by changing the expected literal to the unredacted input (not `assert.fail`). Run `node --test src/redaction.test.ts` then `pnpm test`; both must exit non-zero and the output must name the failing test. Capture both transcripts verbatim. (Requirement: Gate Negative Control)
- [x] 1.5 Revert the single inverted line to the recorded original and re-run `node --test src/redaction.test.ts` and `pnpm test`, both exiting 0; then confirm the inverted fragment is absent from `src/redaction.test.ts`. The inverted state must never be committed. (Requirement: Gate Negative Control)
- [x] 1.6 Run `pnpm test` (canonical, no file path) and confirm exit 0 with `src/redaction.test.ts` named in the output and passing counts — this is the discovery evidence on the local Node line, kept separate from the CI Node-22 evidence. (Requirement: Zero-Dependency Test Runner)
- [x] 1.7 Confirm the colocated test costs no config: `pnpm run typecheck` exits 0, and `git status`/`git diff` show `tsconfig.json` and `tsdown.config.ts` untouched. (Requirement: Colocated `src/**/*.test.ts` Test Convention)
- [x] 1.8 Run `pnpm run build` and list `dist/` — expect exactly `index.js` and `index.d.ts` with no `*.test.*` artifact and no diff to committed build output. (Requirement: Colocated `src/**/*.test.ts` Test Convention)
- [x] 1.9 Create `openspec/changes/add-test-harness/apply-progress.md` with the work-unit-1 evidence: the `package.json` diff summary, the green focused + canonical transcripts, the verbatim **Negative control** block (command, file/line, original and inverted assertion lines, non-zero exit + pasted assertion output, reverted exit 0 run, final-tree absence check), the typecheck/build/`dist/` results, and a `TDD Cycle Evidence` section stating "no RED/GREEN cycle — bootstrap exception, see below" together with the **Bootstrap exception (strict TDD)** block from the design. (Requirements: Gate Negative Control; Strict-TDD Configuration and Bootstrap Ordering; Zero-Dependency Test Runner; Colocated convention)
- [x] 1.10 Commit work unit 1 with the exact explicit staging list, only after `src/redaction.test.ts` is green and the negative control is reverted: `git add -- package.json src/redaction.test.ts .pi-lens.json openspec/changes/add-test-harness/exploration.md openspec/changes/add-test-harness/proposal.md openspec/changes/add-test-harness/design.md openspec/changes/add-test-harness/tasks.md openspec/changes/add-test-harness/specs/testing/spec.md openspec/changes/add-test-harness/apply-progress.md` then `git commit -m "test: add Node stdlib test harness with pilot redaction test"`. Verify `openspec/config.yaml` and `.pi/` are still untracked after the commit.

### Commit 2 — CI test gate + contributor contract

- [x] 2.1 In `.github/workflows/ci.yml`, add a step `- name: Test` with `run: pnpm test` to the `checks` job **after** `Typecheck` and **before** `Build`; change nothing else — `node-version: 22` stays, no matrix, no `continue-on-error`, no `|| true`. Verify the step order by reading the job top to bottom. (Requirement: CI Test Gate)
- [x] 2.2 In `CONTRIBUTING.md`, add `pnpm test` to the Validation section's command block alongside `pnpm run typecheck` and `pnpm run build`, plus one convention line: tests are colocated at `src/**/*.test.ts`, use only the stdlib `node:test`/`node:assert`, add no dependencies, and remain erasable TypeScript (no `enum`, `namespace`, or parameter properties). (Requirement: Contributor Test Contract)
- [x] 2.3 Append the work-unit-2 evidence to `openspec/changes/add-test-harness/apply-progress.md``: the `ci.yml` diff with the `Test` step and its position, the `node-version: 22` line quoted, and the `CONTRIBUTING.md` diff lines. (Requirements: CI Test Gate; Contributor Test Contract)
- [x] 2.4 Commit work unit 2: `git add -- .github/workflows/ci.yml CONTRIBUTING.md openspec/changes/add-test-harness/apply-progress.md` then `git commit -m "ci: gate checks on pnpm test and document the test contract"`.

### Commit 3 — strict-TDD flip (last)

- [x] 3.1 In `openspec/config.yaml`, set `strict_tdd: true`; set `rules.apply.test_command` and `rules.verify.test_command` to `"pnpm test"`; set `testing.runner.command` to `"pnpm test"`, `testing.runner.framework` to `"node:test"`, `testing.layers.unit` to `"node:test"`, and replace `testing.commands.unit` with exactly one entry `{ scope: ".", command: "pnpm test", framework: "node:test" }`. Leave `testing.coverage`, `quality.lint`, `lint_commands`, `format`, `format_commands`, and every `e2e` field empty. (Requirement: Strict-TDD Configuration and Bootstrap Ordering)
- [x] 3.2 In the same `openspec/config.yaml`, refresh `context`: replace the `No reliable test runner was detected…` line and the `Unit tests: none.` line so they describe unit tests as `node:test` run via `pnpm test`, colocated at `src/**/*.test.ts`, stdlib-only; leave the project/markers/package-manager lines and the integration/E2E lines unchanged. Optionally refresh `testing.detected` to the landing date (not an acceptance criterion). (Requirement: Strict-TDD Configuration and Bootstrap Ordering)
- [x] 3.3 Append the work-unit-3 evidence to `openspec/changes/add-test-harness/apply-progress.md`: the `config.yaml` diff, the field-by-field target-state table from the design, the bootstrap-exception record naming commit 1 as the harness commit and this commit as the last one, and the note that any CI rung-1 amendment (explicit test path) or rung-2 CI Node bump consent must be recorded verbatim here. (Requirement: Strict-TDD Configuration and Bootstrap Ordering)
- [x] 3.4 Commit work unit 3 — this is the **last** task and the first commit that sets `strict_tdd: true`: `git add -- openspec/config.yaml openspec/changes/add-test-harness/apply-progress.md` then `git commit -m "chore(openspec): enable strict TDD now that the harness is green"`.
- [x] 3.5 Post-commit end-state verification (read-only, nothing appended after commit 3 — a commit cannot record its own SHA): `git log --oneline -3` matches the design's three messages in order; `git status --short` prints exactly `?? .pi/`; `git show <commit-3>:package.json` contains `"test": "node --test"` and `git show <commit-3>:src/redaction.test.ts` exists; `git show <commit-2>:.github/workflows/ci.yml` contains the `Test` step. Record the three SHAs and the `git status` output in the apply/delivery report, not in a tracked file. (Requirements: Strict-TDD Configuration and Bootstrap Ordering; CI Test Gate)

### Post-apply, evidence-only

- [x] 4.1 Once the branch is pushed, capture rung-0 CI evidence — workflow run URL/id, commit SHA, `Test` step conclusion, and a log excerpt naming `src/redaction.test.ts` with pass counts — in the change's report artifacts and PR body, never as an edit to a tracked file after commit 3. If the `Test` step fails on Node 22, walk the design's contingency ladder in order (rung 1 explicit-path script, pre-authorized, with the spec text amended in the same change and noted in `apply-progress.md`; rung 2 CI Node bump pauses for explicit user consent in `ask-on-risk`; otherwise stop and report blocked). `engines.node: ">=22.18"` is unchanged at every rung, and `continue-on-error`, `|| true`, removing the `Test` step, or `skip`-ing the pilot test are forbidden at every rung. (Requirement: CI Test Gate)
  - Outcome: rung 0 discharged — run `35620396901` on commit `6520200`, Node 22, `Test` step **success**, log `# tests 6` / `# pass 6` / `# fail 0`. No rung-1 amendment and no rung-2 consent were needed. Full evidence table in `apply-progress.md` (`## Post-push: CI rung-0 evidence`).
  - Wording deviation, recorded not glossed: the run log does **not** contain the string `src/redaction.test.ts`. Node 22's TAP reporter omits the file path on an all-green single-file run. The six recorded test names exist only in that file and the repository has no other test file, so the pass counts are the discovery proof. The design's "the step log names `src/redaction.test.ts`" expectation is not literally satisfiable on Node 22 and is superseded by this wording.
  - Two deviations from the task as written, both human-authorized: (a) no pull request was opened — the push went to `main`, matching this repository's own `CONTRIBUTING.md` convention, so the "PR body" locator has no target; (b) this checkbox could only be closed by editing a tracked file after commit 3, done in a fourth evidence-only commit. Those two clauses could not both hold, because native SDD status derives `allComplete` from checkbox lines and an uncheckable-for-the-session task pinned `nextRecommended` to `apply`.
