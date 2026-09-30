# Apply Progress — adopt-cordis-plugin-config

Store: openspec — `openspec/changes/adopt-cordis-plugin-config/apply-progress.md`
Status: implementation complete (all 5 tasks done), ready for archive
Structured status consumed: native `gentle-ai.sdd-status` v2, `nextRecommended: apply`,
`applyState: ready`, `actionContext.mode: repo-local`, edit root
`/home/fy/Projects/code/dsh-gentle-engram`. No warnings reported by `actionContext`.
No previous apply-progress existed (locator was `<unresolved>`); this is the first write.

## Completed tasks

- [x] 1. RED — `src/config.test.ts` harness + fail-closed negatives
- [x] 2. RED — preserved-behaviour, boundary, unknown-key, sentinel, export-identity cases
- [x] 3. GREEN — `src/config.ts` rewritten to the settled schema shape
- [x] 4. GREEN — entry module + every call site migrated in one signature-change unit
- [x] 5. Verify — acceptance gates run, results recorded below

Persisted task checkboxes at `openspec/changes/adopt-cordis-plugin-config/tasks.md` were
updated as each task completed (1–4 after GREEN, 5 at the end). All five lines read `- [x]`.

Remaining tasks: none. No unchecked `- [ ]` line remains in `tasks.md`.

## Files changed

| File | Change | Authored lines (+/−) |
|---|---|---|
| `src/config.ts` | Rewrite: `FIELDS` + `Config` + `ConfigInput`/`ConfigOutput`; removed `RawEngramConfig`, `DEFAULT_CONFIG`, `pick*`, the warning path; `resolveConfig` = key check → schema → env → `url` fold | +86 / −59 |
| `src/config.test.ts` | New colocated stdlib test, 21 cases | +214 |
| `src/index.ts` | `export { Config }`; `apply(ctx, rawConfig?: ConfigOutput)`; `resolveConfig(rawConfig)`; dropped the `logger.warn` sink | +8 / −3 |
| `src/engram/client.test.ts` | `RawEngramConfig` → `type ConfigInput`; three `resolveConfig` call sites drop the `warn` arg | +4 / −4 |
| `src/engram/server.test.ts` | One call site drops the `warn` arg | +1 / −1 |
| `src/recall-scope.test.ts` | One call site drops the `warn` arg | +1 / −1 |
| `src/disposal.test.ts` | **Deviation**: `apply(..., { url })` → `apply(..., Config({ url }))` + import | +2 / −2 |
| `src/injection.test.ts` | **Deviation**: same fix at its `apply` call site | +2 / −2 |

Not touched: `cordis.patch.yml` (byte-identical, `git diff` empty), `package.json`,
`pnpm-lock.yaml`, `tsconfig.json`, `tsdown.config.ts`, `README.md`, `docs/**`,
`CHANGELOG.md`, workflows, version. No new file beyond the design's list (only
`src/config.test.ts` is new). No commit, stash, checkout, or rebase was performed.

## Commands run and exact results

| Command | Result |
|---|---|
| `pnpm test` (pre-change baseline) | exit 0 — `tests 101 / pass 101 / fail 0` |
| `pnpm run typecheck` (baseline) | exit 0 |
| `pnpm run build` (baseline) | exit 0 — `dist/index.js` 71.82 kB, `dist/index.d.ts` 0.67 kB |
| `pnpm test` (RED, task 1) | exit 1 — `SyntaxError: The requested module './config.ts' does not provide an export named 'Config'`, `✖ src/config.test.ts`, `tests 102 / pass 101 / fail 1` |
| `pnpm test` (RED, task 2) | exit 1 — same missing-export failure, `tests 102 / pass 101 / fail 1`; no pre-existing file failed |
| `pnpm test` (GREEN, tasks 3–4) | exit 0 — `tests 117 / pass 117 / fail 0` (101 baseline + 16) |
| `pnpm run typecheck` (first GREEN pass) | exit 2 — 2 errors: `src/disposal.test.ts(86,36)` and `src/injection.test.ts(60,36)`, partial `{ url }` not assignable to `ConfigOutput` |
| `pnpm run typecheck` (after the two call sites) | exit 0 |
| `node --test src/config.test.ts` (traingulation) | exit 0 — `tests 21 / pass 21 / fail 0` |
| `pnpm test` (final) | exit 0 — `tests 122 / pass 122 / fail 0` (101 baseline + 21 new) |
| `pnpm run typecheck` (final) | exit 0 |
| `pnpm run build` (final) | exit 0 — `dist/index.js` 107.23 kB (gzip 29.97 kB), `dist/index.d.ts` 1.47 kB |

Runtime probe (`node --input-type=module -e`, against `src/config.ts`):

```
1. Config[~standard] present: true | version 1
2. Config({}) -> {"binary":"engram","url":"","port":7437,"captureToolResults":true,"capturePrompts":true,"requestTimeoutMs":3000,"startupTimeoutMs":10000,"fetchMaxAttempts":3}
3. in-repo cordis.patch.yml block resolves -> {"binary":"engram","port":7437,"captureToolResults":true,"capturePrompts":true,"requestTimeoutMs":3000,"startupTimeoutMs":10000,"fetchMaxAttempts":3}
4. url sentinel never escapes: undefined
```

## TDD Cycle Evidence

Strict TDD active (`openspec/config.yaml: strict_tdd: true`, runner `pnpm test`).

| Task | Phase | Evidence |
|---|---|---|
| 1 | RED | `src/config.test.ts` added against the unchanged module; `pnpm test` failed with `does not provide an export named 'Config'` on `src/config.test.ts` only (101 pre-existing tests still passed). Typecheck also reported the intended missing-export / one-arg-`resolveConfig` errors. |
| 2 | RED | Extended the same file with preserved-behaviour and boundary cases; `pnpm test` still failed only on `src/config.test.ts`. |
| 3 | GREEN | `src/config.ts` rewritten; `pnpm test` 117/117 once the call sites moved (see task 4). |
| 4 | GREEN | `src/index.ts` + 6 call sites migrated; `pnpm test` exit 0 (117), then `pnpm run typecheck` exit 0 after two extra call sites were found. |
| 3–4 | TRIANGULATE | Five held-out cases added (whitespace-only `url` fold, padded `binary` normalization, blank `ENGRAM_BIN`/`ENGRAM_URL` fall-through, `TypeError` for an unknown key beside valid keys, `resolveConfig`-level non-integer + `ENGRAM_PORT=0`). All five passed on first run — the schema-based implementation was already general, so no further generalization was required. Result: `node --test src/config.test.ts` exit 0, 21/21. |
| 3 | REFACTOR | Read the final module in full. No honest simplification available: `natural().min().max().default()`, the `Object.keys(raw)` diff, and the field-by-field returned literal are each load-bearing (the last one is what enforces `EngramConfig` parity per design T5). No code was compressed to fit the budget; no comments, blank lines, docs, or tests were deleted. |

## Spec acceptance criteria verified

- Req 1 — `Config` is a named export of both `src/config.ts` and `src/index.ts` and the values are identical (test: "Config is the same value exported by the plugin entry module"); `Config['~standard']` exists with a `validate` function (probe 1); exactly the eight fields (probe 2); `name`/`inject`/`apply` arity unchanged.
- Req 2 — every out-of-range, wrong-typed, and blank-`binary` case throws `ValidationError`; no supplied-but-invalid value is replaced by a default.
- Req 3 — defaults and bounds preserved exactly, asserted against an independent `DEFAULTS` oracle for `undefined` and `{}`; all eight boundary values preserved; the in-repo `cordis.patch.yml` block resolves to the previous behaviour (probe 3).
- Req 4 — `{ port: 1.5 }` and `{ requestTimeoutMs: 3000.5 }` throw; no `Math.trunc` / `Math.round` / `Number.parseInt` remains in the config path (`grep` clean); `resolveConfig`-level non-integer throws.
- Req 5 — `{ bogus: 1 }` throws a `TypeError` naming `bogus`; the schema's unknown-key pass-through is pinned by test, proving the explicit check is load-bearing; `resolveConfig` no longer takes `warn` and `src/index.ts` has no config `ctx.logger.warn` call.
- Req 6 — `ENGRAM_PORT` / `ENGRAM_BIN` / `ENGRAM_URL` still override yml; invalid yml throws even with a valid `ENGRAM_PORT` set.
- Req 7 — `ENGRAM_PORT=abc|99999|1.5` throw a `TypeError` naming `ENGRAM_PORT`; blank and whitespace-only values count as unset.
- Req 8 — `EngramConfig.url` stays `string | undefined`; `{}` and `{ url: '' }` fold to `undefined`; a configured/yml URL survives; no resolved config exposes `''`.
- Req 9 — no `RawEngramConfig`, no standalone `DEFAULT_CONFIG`, no `pick*`, no unknown-key warning path (`grep` clean); all call sites compile against the one-argument signature.
- Req 10 — `src/config.test.ts` uses only `node:test` / `node:assert/strict` and `src/config.ts` / `src/index.ts`; every env case goes through the restoring `withEnv` helper; `pnpm test` exit 0 with all 21 cases named as passing.
- Req 11 — see scope containment below.

## Deviations from the design

1. **Two extra call sites (design's `## File changes` list is incomplete).** `src/disposal.test.ts:86`
   and `src/injection.test.ts:60` also call `apply(ctx, { url })`. Because `apply` now takes the
   settled `ConfigOutput` (all fields required), those partial literals stopped typechecking
   (`TS2345`, reported by `pnpm run typecheck`). Fixed minimally and honestly by passing the
   plugin's own validated output — `Config({ url })` — via the new `Config` re-export. The
   settled `ConfigOutput` decision was **not** reopened and `apply`'s signature was **not**
   widened to `ConfigInput`. This is a call-site migration, not a behaviour change.
2. **`dist/index.d.ts` carries a type-only `import Schema from "@deepseek-ai/schemastery"`.**
   The design's guarantee (`dist/index.js` has no bare schemastery import — schema inlined) is
   met: `grep` finds no such import in `dist/index.js`. `tasks.md` task 5 asked for *both* dist
   files to be free of it, which is **not** met: exporting a schema value necessarily makes the
   emitted declaration reference its type. Fixing it would require either adding schemastery to
   `peerDependencies` or erasing `Config`'s type — both forbidden by the hard constraints. The
   only `dist` consumer affected is a downstream type-checker resolving `@deepseek-ai/schemastery`,
   and `tsconfig.json` already sets `skipLibCheck: true`. Flagged for verify/archive, not fixed.
3. **Realized size above forecast.** 390 authored lines vs the design's ~250–300 forecast. The
   overage is the test file (214 realized vs ~110–125 forecast: 21 cases including the
   triangulation round) plus the two extra call sites. No code was compressed or deleted to
   chase the number.

No other deviation: defaults, bounds, layering order, type names, error types, and the
`Object.keys(raw)` diff all match the settled decisions exactly.

## Workload / PR boundary

- Authored change size: **390 changed lines** (`git diff --numstat` for `src/` = 176, plus 214
  added lines for the new untracked `src/config.test.ts`) against the 400-line budget —
  **within budget, with 10 lines of headroom**. SDD artifacts (`tasks.md` checkbox edits and
  this file) are process records, not part of the reviewed code diff.
- `delivery_strategy: ask-on-risk`, `chain_strategy: not selected`. The budget was not exceeded,
  so no chained/stacked split is needed and no delivery decision is required. The count is
  reported explicitly because it is far closer to 400 than the Low-risk forecast implied; a
  maintainer who wants the headroom restored can split the test file, but that is a judgement
  call, not a gate trigger.
- Single PR, one cohesive work unit: the module rewrite, its colocated tests, the entry-module
  export, and the call-site migration cannot be separated — the signature change does not
  typecheck or run in pieces.
- Rollback boundary: revert `src/config.ts`, `src/index.ts`, the six call-site edits, and delete
  `src/config.test.ts`. No config file, dependency, environment variable, or published artifact
  is mutated, so rollback has no external effect.

## Scope containment (spec requirement 11)

- `git diff -- cordis.patch.yml` → **empty** (byte-identical).
- `git diff -- package.json` → only the two `devDependencies` lines (`@deepseek-ai/dsh-compaction`,
  `@deepseek-ai/schemastery`) that the working tree **already carried before apply**; the parent
  prompt recorded them and the pre-apply `git status` showed ` M package.json`. Apply added
  nothing to this file. `dependencies` / `peerDependencies` are untouched; `@deepseek-ai/schemastery`
  stays a devDependency; no version bump, tag, publish, or workflow change.
- `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/**`, `tsconfig.json`, `tsdown.config.ts`
  are untouched.
- No commit, stash, checkout, or rebase was performed; version control is left to the parent.

## Structured status produced

Consumed: native v2 status with `applyState: ready`, `nextRecommended: apply`,
`actionContext.mode: repo-local`, edit root = repository root. All five tasks are now complete with
persisted `- [x]` checkboxes, so the state this phase produces is `applyState: all_done` and the
classic fresh recommendation becomes **archive** (verification is explicitly optional). The parent
should re-query native status rather than relying on this projection; no status tool was invoked
from this phase.
