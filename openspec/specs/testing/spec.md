# Testing Specification

## Purpose

`dsh-gentle-engram` MUST have an executable test harness so SDD apply and verify
phases can produce real RED/GREEN evidence instead of prose claims. The harness
uses Node's built-in test runner (`node:test`) with no new dependencies. This is
a new domain spec introduced by change `add-test-harness`; no canonical
`testing` spec existed before it, so every requirement below is a new addition
(there are no MODIFIED or REMOVED operations). Test suites for the other 11
modules, shared
fakes/fixtures, production seam refactors, coverage tooling, watch mode, and
real-Engram e2e tests are out of scope for this change.

## Requirements

### Requirement: Zero-Dependency Test Runner

`package.json` MUST declare `"test": "node --test"`, making `pnpm test` the
canonical full-suite command. The script and the first test file MUST land in
the same change so `pnpm test` never targets an empty suite. The
`dependencies`, `devDependencies`, and `peerDependencies` sections MUST NOT
change, and `prepublishOnly` MUST remain
`pnpm run typecheck && pnpm run build`.

**Acceptance criteria:**

- Reading `package.json` shows `"test": "node --test"` under `scripts`.
- `pnpm test` exits 0 and its output includes `src/redaction.test.ts` with passing tests.
- The change diff for `package.json` adds only `scripts.test` and the `engines` field; dependency sections are byte-identical.
- `prepublishOnly` still reads `pnpm run typecheck && pnpm run build`.

#### Scenario: Full suite runs green with no new dependencies

- GIVEN the change is applied and dependencies are installed
- WHEN `pnpm test` runs from the repo root
- THEN it exits 0
- AND the output shows the pilot test file with passing tests
- AND no dependency section in `package.json` differs from before the change

#### Scenario: Prepublish gate is unchanged

- GIVEN the applied change
- WHEN the `scripts` section of `package.json` is read
- THEN `prepublishOnly` is still `pnpm run typecheck && pnpm run build`
- AND no test command was added to it

### Requirement: Colocated `src/**/*.test.ts` Test Convention

Test files MUST live under `src/` with a `.test.ts` suffix. They MUST be
typechecked through the existing `tsconfig.json` `include` (`src/**/*.ts`) with
no `tsconfig.json` change, MUST be written in erasable TypeScript (no `enum`,
`namespace`, or constructor parameter properties), and MUST NOT be emitted to
`dist/` or shipped in the published package. Test code MUST use only the
Node.js standard library (`node:test`, `node:assert`).

**Acceptance criteria:**

- `pnpm run typecheck` exits 0 with the pilot test in `src/`, and `tsconfig.json` and `tsdown.config.ts` are unchanged by this change.
- `pnpm run build` exits 0 and `dist/` contains only `index.js` and `index.d.ts` — no `*.test.*` artifact.
- `package.json` `files` lists neither `src` nor any test path.

#### Scenario: Typecheck covers colocated tests for free

- GIVEN `src/redaction.test.ts` exists
- WHEN `pnpm run typecheck` runs
- THEN it exits 0
- AND neither `tsconfig.json` nor `tsdown.config.ts` was modified by this change

#### Scenario: Tests never reach the published package

- GIVEN the pilot test exists
- WHEN `pnpm run build` runs
- THEN `dist/` contains exactly `index.js` and `index.d.ts`
- AND `package.json` `files` does not include `src` or any `*.test.*` path

### Requirement: Declared Node Runtime Floor

`package.json` MUST declare `engines.node` as `>=22.18` — the first release
line where type stripping runs by default, i.e. the minimum that can execute
the harness.

**Acceptance criteria:**

- Reading `package.json` shows `"engines": { "node": ">=22.18" }`.
- The declared lower bound is greater than or equal to `22.18`.

#### Scenario: Engines floor matches harness capability

- GIVEN the applied change
- WHEN `package.json` is inspected
- THEN `engines.node` is exactly `>=22.18`
- AND no other `engines` entry was added

### Requirement: CI Test Gate

The `checks` job in `.github/workflows/ci.yml` MUST include a step named `Test`
that runs `pnpm test`, positioned after `Typecheck` and before `Build`, so a
failing test fails the job. CI MUST keep `node-version: 22`, MUST NOT add a
matrix, and MUST NOT change any other step.

**Acceptance criteria:**

- `.github/workflows/ci.yml` contains a `Test` step with `run: pnpm test` located between the `Typecheck` and `Build` steps of `checks`.
- `node-version: 22` is unchanged; no matrix is added; other steps are unchanged.
- The first CI run on this change executes the `Test` step and its outcome is recorded in the change's progress/report artifacts. If default discovery fails on Node 22, the fallback is an explicit test path (`node --test src/redaction.test.ts`) — never a CI Node bump, which would pause for a delivery decision.

#### Scenario: Gate exists in the correct position

- GIVEN the applied change
- WHEN the `checks` job steps in `.github/workflows/ci.yml` are read in order
- THEN a `Test` step running `pnpm test` appears after `Typecheck` and before `Build`

#### Scenario: CI proves the gate on Node 22

- GIVEN a CI run on the change (pull request or `main` push)
- WHEN the `checks` job completes
- THEN the `Test` step ran and its conclusion reflects the test exit status
- AND the observed result is captured in the change's apply/verify artifacts as the Node-22 discovery evidence

### Requirement: Strict-TDD Configuration and Bootstrap Ordering

`openspec/config.yaml` MUST declare strict TDD enabled with the harness as the
apply/verify test command. Bootstrap ordering is a hard constraint:
`strict_tdd: true` MUST NOT be set until the `test` script and the passing
pilot test exist, and the one-time bootstrap exception MUST be recorded.

**Acceptance criteria:**

- `strict_tdd: true`.
- `rules.apply.test_command` and `rules.verify.test_command` are both `"pnpm test"`.
- `testing.runner.command` is `"pnpm test"` and `testing.runner.framework` is `"node:test"`; `testing.layers.unit` is `"node:test"`; `testing.commands.unit` has one entry with scope `"."`, command `pnpm test`, framework `node:test`.
- `context` no longer contains `No reliable test runner was detected` or `Unit tests: none.`, and describes unit tests as `node:test` run via `pnpm test`.
- `testing.coverage`, `quality.lint`, and all `e2e` fields remain empty.
- In git history, the commit that first sets `strict_tdd: true` already contains `"test": "node --test"` in `package.json` and the file `src/redaction.test.ts`.
- `apply-progress.md` records the bootstrap exception: runner and pilot test landed before the strict-TDD flip.

#### Scenario: Config enables the gate

- GIVEN the applied change
- WHEN `openspec/config.yaml` is read
- THEN `strict_tdd: true`, both test commands are `pnpm test`, and runner/layer metadata is `node:test`
- AND the `context` block describes `node:test` via `pnpm test` instead of claiming no reliable runner exists

#### Scenario: Bootstrap ordering is respected

- GIVEN the change's task order and git history
- WHEN the commit that first sets `strict_tdd: true` is inspected (`git show <commit>:package.json`, `git show <commit>:src/redaction.test.ts`)
- THEN that commit already contains the `test` script and the pilot test file
- AND `apply-progress.md` records the bootstrap exception explicitly

### Requirement: Pilot Redaction Coverage

`src/redaction.test.ts` MUST be the first test file and MUST cover all four
exported functions of `src/redaction.ts` — `redactPrivateTags`, `redactUrlPath`,
`redactValue`, `redactText` — using only `node:test` with
`node:assert/strict`, including at least one edge case per function.

**Acceptance criteria:**

- The file imports the four functions from `./redaction.ts`, each name appears in at least one test case, and `pnpm test` exits 0.
- `redactPrivateTags`: each `<private>...</private>` block (case-insensitive, multiline, multiple per input) becomes `[REDACTED]`; untagged text is unchanged.
- `redactUrlPath`: a private block in a path segment or in a percent-encoded query value is redacted while pathname and query structure are preserved.
- `redactValue`: strings are redacted recursively, object/array shape is preserved, and non-string primitives pass through unchanged.
- `redactText`: input is redacted and then trimmed.
- Assertions check real behavior; no tautologies and no assertion-free tests.

#### Scenario: All four redaction functions are exercised

- GIVEN the pilot test exists
- WHEN `pnpm test` runs
- THEN it exits 0
- AND each of the four function names appears in at least one test case in `src/redaction.test.ts`

#### Scenario: Edge cases are asserted

- GIVEN the pilot test file is read
- WHEN its test cases are inspected
- THEN it covers multiple/case-insensitive/multiline private blocks, a private value in a query string, nested objects and arrays passed to `redactValue`, and whitespace plus a private tag passed to `redactText`

### Requirement: Gate Negative Control

The harness MUST be proven able to fail. During apply, one assertion in
`src/redaction.test.ts` MUST be deliberately inverted, `pnpm test` MUST exit
non-zero, and reverting that assertion MUST restore a green run. The actual
commands and observed outputs MUST be recorded in `apply-progress.md` so the
evidence is reproducible after the fact rather than asserted in prose.

**Acceptance criteria:**

- With one assertion deliberately inverted, `pnpm test` exits non-zero and the output identifies the failing test.
- After reverting the inversion, `pnpm test` exits 0.
- `apply-progress.md` contains the actual command(s) executed, the observed non-zero output, and the restored green run.

#### Scenario: Inverted assertion fails the gate

- GIVEN `src/redaction.test.ts` with one assertion deliberately inverted
- WHEN `pnpm test` runs
- THEN it exits non-zero
- AND the failing test and assertion are identified in the output

#### Scenario: Revert restores green and evidence is recorded

- GIVEN the inverted assertion has been reverted
- WHEN `pnpm test` runs
- THEN it exits 0
- AND `apply-progress.md` contains the inverted-assertion command and its observed non-zero output

### Requirement: Contributor Test Contract

`CONTRIBUTING.md` MUST document `pnpm test` in its Validation section and state
the test convention: tests are colocated at `src/**/*.test.ts`, use only stdlib
`node:test`/`node:assert`, add no dependencies, and remain erasable TypeScript
(no `enum`, `namespace`, or parameter properties).

**Acceptance criteria:**

- The Validation section lists `pnpm test` alongside `pnpm run typecheck` and `pnpm run build`.
- A convention line states `src/**/*.test.ts`, stdlib-only `node:test`/`node:assert`, no new dependencies, and the erasable-TS constraint.

#### Scenario: Validation docs match the harness

- GIVEN the applied change
- WHEN the Validation section of `CONTRIBUTING.md` is read
- THEN `pnpm test` appears as a required check
- AND the colocated `src/**/*.test.ts`, stdlib-only, and erasable-TS convention is stated
