# Proposal — add-test-harness

Status: proposal (awaiting review)
Change: `add-test-harness`
Store: openspec — `openspec/changes/add-test-harness/proposal.md`
Source: `openspec/changes/add-test-harness/exploration.md`
Review size: ~40–80 authored lines — under the 400-line budget; no `size:exception`, no chaining.

## Problem statement

`dsh-gentle-engram` ships zero test files and no `test` script, so no SDD apply or
verify phase can produce executable RED/GREEN evidence — any "verified" claim is
prose. `openspec/config.yaml` therefore declares `strict_tdd: false` with empty
`apply.test_command` / `verify.test_command`, and gentle-pi's orchestrator only
forwards `STRICT TDD MODE IS ACTIVE` when BOTH are set. Four pure, high-value
functions (`redactPrivateTags`, `redactUrlPath`, `redactValue`, `redactText`) have no
executable regression protection at all.

The gap is wiring and convention, not tooling capability: Node's stdlib `node:test`,
native type stripping (Node ≥ 22.18), explicit `.ts` import specifiers, and erasable
syntax are all already in place. Without this change, every later change in this repo
is unverifiable by construction.

## Intent

Wire the existing Node stdlib runner into the project, prove the wiring end to end
with one real test file, and only then declare strict TDD so every later change is
gated on actual failing-then-passing tests.

## Capabilities established (durable)

| Capability | Concretely |
| --- | --- |
| Zero-dependency test runner | `package.json` `"test": "node --test"`; canonical command `pnpm test`; no `devDependencies` change |
| Colocated test convention | `src/**/*.test.ts` — typechecked for free by the existing `tsconfig.json` `include: ["src/**/*.ts"]`, never bundled (tsdown entry is `src/index.ts` only), never published (`files` lists `dist`, not `src`) |
| Runtime floor declared | `package.json` `engines.node: ">=22.18"` — first release with type stripping on by default, i.e. the minimum that can run the harness |
| CI test gate | `Test` step (`pnpm test`) added to the `checks` job in `.github/workflows/ci.yml` |
| Strict TDD gateable | `openspec/config.yaml`: `strict_tdd: true`, `rules.apply.test_command`/`rules.verify.test_command` = `pnpm test`, runner/layer/unit command `node:test`, `context` no longer claims no runner exists |
| First real coverage | `src/redaction.test.ts` covering all four redaction functions with edge cases |
| Contributor contract | `CONTRIBUTING.md` Validation section documents `pnpm test` plus the colocated + stdlib-only convention in one line |

## Scope

**In scope (exact file list):**

| File | Change | Rough lines |
| --- | --- | --- |
| `package.json` | `test` script; `engines.node: ">=22.18"` | ~5 |
| `src/redaction.test.ts` | new pilot test (stdlib `node:test` + `node:assert/strict`) | ~30–50 |
| `.github/workflows/ci.yml` | `Test` step in `checks`, after `Typecheck` and before `Build` | ~3 |
| `openspec/config.yaml` | strict-TDD switch + context refresh | ~15 |
| `CONTRIBUTING.md` | Validation section: `pnpm test` + convention line | ~4 |

**Explicit non-goals (from the scope guard):**

- Test suites for the other 11 modules — each is its own follow-up change.
- Shared fakes/fixtures helpers, and any production seam refactors (e.g. `spawn` injection for `src/engram/server.ts`, `fetch` injection for the client).
- Coverage tooling (`--experimental-test-coverage`), watch mode, e2e against a real Engram server.
- Exporting module-private helpers (`queryString`, `boundContext`, …) purely for tests.
- `prepublishOnly` and `.github/workflows/publish.yml` gating; CI matrix changes; changing `node-version: 22`.
- `tsconfig.json` / `tsdown.config.ts` changes; new dependencies.

## Risks and how this proposal handles them

**1. CI Node 22 vs local Node 26 — carried forward, not assumed.** CI pins
`node-version: 22`; local is Node 26.9.0 where `node --test` `.ts` discovery is
parent-verified. The same behavior on Node 22 depends on default-on type stripping
(≥ 22.18). Handling: keep `node-version: 22` as decided, ship the pilot test in the
same change so CI is never gated on an empty suite, and treat the first CI run as the
proof rather than a claim. If discovery fails there, the ordered fallback is
(a) explicit test paths (`node --test src/redaction.test.ts`, supported on Node 22) and
(b) only then a CI Node major bump — which is a delivery decision, so it pauses and
asks (ask-on-risk) instead of silently changing CI. `engines.node: ">=22.18"` states
the same minimum for contributors and consumers.

**2. Strict-TDD bootstrap ordering — hard constraint.** A config-only edit cannot
produce a meaningful pre-implementation RED; flipping `strict_tdd: true` first would
make this very change unsatisfiable ("failing test before production code" with no
runner and no test). Handling: sequence the tasks as (1) `test` script, (2) pilot test
authored and run while `strict_tdd: false`, (3) `strict_tdd: true` plus the
apply/verify test commands as the LAST task, with the bootstrap exception recorded
explicitly in `apply-progress.md`. The pilot test targets pre-existing, working
functions, so it is harness self-proof rather than a TDD cycle; the runner's ability
to fail is proven by a one-shot negative control (below), and the first genuine
RED/GREEN cycle belongs to the first module-suite change. This change's own enablement
is the only declared exception.

**3. Colocated tests × tsdown — low, verified once.** Entry-only bundling cannot pull
in unreferenced test files, and `files: ["dist", …]` keeps `src/` out of the package.
Handling: one explicit `pnpm run build` after the pilot test lands, expecting `dist/`
unchanged at `index.js` + `index.d.ts`.

**4. Zero-test invocation ambiguity.** If `node --test` discovers nothing, exit status
is not trustworthy across versions. Handling: script and pilot test land together, so
the CI gate is never pointed at an empty suite.

**5. Erasable-syntax constraint.** Type stripping does not typecheck, so test files
must stay erasable TS (no enum/namespace/parameter properties) and must be covered by
`pnpm run typecheck`, which they are via the existing `include`. The repo already
complies; this constraint becomes permanent and is documented in `CONTRIBUTING.md`.

**6. Publish gate deliberately unchanged.** Tests gate PR/main CI only; release
publishing keeps `prepublishOnly` = typecheck + build. Revisiting this is a separate
follow-up decision, not part of this change.

## Rollback

All edits are additive and local: revert the commit(s) with `git revert`. Concretely —
remove the `test` script and `engines` field, delete `src/redaction.test.ts`, drop the
CI `Test` step, set `strict_tdd: false` and restore the previous `context`/`testing`
lines, revert the `CONTRIBUTING.md` lines. No production code, data, dependency, or
published artifact changes, so rollback has no runtime blast radius; the only effect
is that strict TDD becomes unavailable again.

## Success criteria

- `pnpm test` exists and runs `src/redaction.test.ts` green locally on Node 26.
- Negative control: with one assertion deliberately inverted, `pnpm test` exits
  non-zero; reverting restores green. This proves the gate can fail, not merely pass.
- `pnpm run typecheck` still passes with the colocated test in scope (no tsconfig edit).
- `pnpm run build` leaves `dist/` at `index.js` + `index.d.ts` (no test artifacts).
- CI `checks` job contains the `Test` step, and the first CI run on Node 22 exercises
  it — answering the Node-22 discovery question with evidence rather than assumption.
- `openspec/config.yaml` declares `strict_tdd: true`, `apply`/`verify`
  `test_command: "pnpm test"`, runner `node:test`, and no longer states that no
  reliable test runner was detected.
- `CONTRIBUTING.md` lists `pnpm test` and the `src/**/*.test.ts` + stdlib-only convention.
- The bootstrap exception (harness + pilot before the `strict_tdd` flip) is recorded
  in `apply-progress.md`.
- Zero dependency changes; `prepublishOnly` and `publish.yml` untouched.
