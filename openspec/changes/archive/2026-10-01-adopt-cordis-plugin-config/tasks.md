# Tasks — adopt-cordis-plugin-config

Store: openspec — `openspec/changes/adopt-cordis-plugin-config/tasks.md`
Spec: `openspec/changes/adopt-cordis-plugin-config/specs/config/spec.md` (11 requirements)
Design: `openspec/changes/adopt-cordis-plugin-config/design.md`
TDD: strict (`openspec/config.yaml`), runner `pnpm test`, typecheck `pnpm run typecheck`.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~250–300 (design forecast: ~185–215 added across the four changed files, plus ~110–125 deleted in the `src/config.ts` rewrite) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

```text
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low
```

Forecast basis: the design's `## File changes` list is the whole scope — one module rewrite
(`src/config.ts`, currently 122 lines), one new colocated test file (`src/config.test.ts`),
a 3-line entry-module change (`src/index.ts`), and five mechanical call-site edits in three
existing test files. No dependency, doc, config-file, or workflow change contributes lines.
The upper bound stays under the 400-line budget, so `ask-on-risk` needs no pre-apply decision;
if the realized diff crosses 400 during apply, delivery pauses and asks instead of chaining.

## Tasks

- [x] 1. RED — create `src/config.test.ts` with the stdlib-only harness and the fail-closed
      negative cases, against the current, unchanged module.
      Add `import { test } from 'node:test'` / `assert` from `node:assert/strict`, the
      `raw(value: Record<string, unknown>): ConfigInput` cast helper, the `DEFAULTS: EngramConfig`
      oracle literal, and the `withEnv(values, fn)` save/restore helper (it sets exactly the named
      vars and deletes `ENGRAM_URL`/`ENGRAM_BIN`/`ENGRAM_PORT` otherwise, restoring in `finally`).
      Cases: `{ port: 99999 }`, `{ port: 'abc' }`, `{ port: 1.5 }`, `{ port: 0 }`,
      `{ port: 65536 }`, `{ requestTimeoutMs: 99 }`, `{ requestTimeoutMs: 3000.5 }`,
      `{ startupTimeoutMs: 499 }`, `{ fetchMaxAttempts: 9 }`, `{ binary: '' }`, `{ binary: '   ' }`,
      `{ capturePrompts: 'yes' }`, `{ bogus: 1 }`, `ENGRAM_PORT=abc`, `ENGRAM_PORT=99999`,
      `ENGRAM_PORT=1.5` — each via `assert.throws(..., { name: 'ValidationError' })` or a
      message/regex match as the design's `## Q4` table specifies.
      Evidence: `pnpm test` fails, its output naming `src/config.test.ts`; the failures are the
      intended RED (`Config` is not yet a function / `resolveConfig` arity). Record the
      pre-change `pnpm test` baseline (green) first so the RED delta is attributable.

- [x] 2. RED — extend `src/config.test.ts` with the preserved-behaviour and boundary-positive
      cases, still against the current module.
      Cases: `resolveConfig(undefined)` and `resolveConfig({})` deep-equal `DEFAULTS` (including
      the `url: undefined` own key); `Config(raw({}))` yields the eight defaults; boundary values
      `port: 1`, `port: 65535`, `requestTimeoutMs: 100`, `requestTimeoutMs: 120000`,
      `startupTimeoutMs: 500`, `startupTimeoutMs: 300000`, `fetchMaxAttempts: 1`,
      `fetchMaxAttempts: 8` are preserved exactly; `ENGRAM_PORT=1234` overrides `{ port: 7437 }`;
      `ENGRAM_BIN` overrides `binary`; `ENGRAM_URL` overrides yml `url`; `{ port: 'abc' }` still
      throws with `ENGRAM_PORT=1234` set; `ENGRAM_PORT=''` and `'   '` fall through as unset; the
      `url` sentinel folds `''` → `undefined` and a yml `url` survives; the schema-passthrough pin
      `(Config(raw({ bogus: 1 })) as Record<string, unknown>).bogus === 1`; and export identity
      `import { Config as IndexConfig } from './index.ts'` with `assert.equal(IndexConfig, Config)`.
      Deliberate-invalid inputs go through the `raw(...)` helper; every env case goes through
      `withEnv`.
      Evidence: `pnpm test` still fails on `src/config.test.ts`, with only the intended RED cases
      failing (no failures in pre-existing test files).

- [x] 3. GREEN — rewrite `src/config.ts` to the design's settled shape.
      Add module-private `FIELDS` (one object, eight entries) and build `Config` with
      `Schema.natural().min(lo).max(hi).default(d)` for `port`, `requestTimeoutMs`,
      `startupTimeoutMs`, `fetchMaxAttempts`; `binary` with `pattern(/\S/)` default `'engram'` and
      `url` default `''`; booleans with their current defaults. Export `Config`, `ConfigInput`
      (`Schemastery.TypeS<typeof Config>`) and `ConfigOutput` (`Schemastery.TypeT<typeof Config>`);
      keep `EngramConfig` verbatim as the hand-written `url: string | undefined` interface and keep
      `engramAuthToken`. Remove `RawEngramConfig`, the standalone `DEFAULT_CONFIG`, `pickNumber` /
      `pickBoolean` / `pickString`, and the unknown-key warning path. Add `assertKnownKeys` over
      `new Set(Object.keys(FIELDS))` throwing a `TypeError` naming the key and listing the expected
      keys. Reduce `resolveConfig(raw?: ConfigInput): EngramConfig` to the settled order:
      `assertKnownKeys → Config(raw ?? {}) → validated env precedence → url fold`; rewrite
      `envPort()` to use `Number(raw)` + `Number.isFinite` + `FIELDS.port(value)`, wrapping failures
      in a `TypeError` naming `ENGRAM_PORT`; keep `envString` blank-is-unset semantics and keep the
      `binary`/`url` trims.
      Evidence: `pnpm test` exits 0 with `src/config.test.ts` listed and all its cases passing
      (Node runs TS via type stripping, so call-site type errors do not block this gate).

- [x] 4. GREEN — migrate the entry module and every call site in one signature-change unit, so the
      reduced `resolveConfig` typechecks everywhere at once.
      `src/index.ts`: import `resolveConfig` plus `type ConfigOutput`, add
      `export { Config } from './config.ts'`, change `apply(ctx, rawConfig?: RawEngramConfig)` to
      `apply(ctx, rawConfig?: ConfigOutput)`, and drop the `message => ctx.logger.warn(...)` sink.
      Call sites: `src/engram/server.test.ts:102`, `src/recall-scope.test.ts:59`,
      `src/engram/client.test.ts:5` (import `type ConfigInput` instead of `RawEngramConfig`),
      `:66–67`, and `:380` — each `resolveConfig(x, () => {})` becomes `resolveConfig(x)`.
      No other file changes; `cordis.patch.yml`, `package.json`, `tsconfig.json`,
      `tsdown.config.ts`, docs, changelog, and version stay untouched.
      Evidence: `pnpm run typecheck` exits 0 and `pnpm test` exits 0 with all pre-existing test
      files still green.

- [x] 5. Verify — run the acceptance gates the spec pins and record exact results.
      `pnpm test` exit 0 with `src/config.test.ts` named as passing; `pnpm run typecheck` exit 0;
      `pnpm run build` exit 0 with `dist/index.js` and `dist/index.d.ts` present and containing no
      bare `@deepseek-ai/schemastery` import (schema inlined). Scope containment:
      `git diff --stat` shows only the six files in the design's `## File changes` list,
      `git diff -- cordis.patch.yml package.json` is empty, and the authored additions+deletions
      total stays under 400 (report it, and pause for a delivery decision if it does not).
      Evidence: the four command outputs pasted into the apply report, plus the diff stat and the
      empty `cordis.patch.yml` / `package.json` diff.

## Notes

- No task adds a file beyond the design's `## File changes` list; adding one is a decision, not a
  task.
- Non-goals carry no tasks: no publish/release/version/tag, no docs, no `cordis.patch.yml` edit,
  no dependency change, no `name` / `inject` / `apply`-signature change, no config discovery,
  profiles, layered yml, hot reload, or new fields.
- Settled implementation decisions are consumed, not reopened: `Schema.natural().min().max().default()`,
  `ConfigInput`/`ConfigOutput` with `EngramConfig` kept verbatim, `Object.keys(raw)` diff throwing
  `TypeError`, `{ name: 'ValidationError' }` matching plus `withEnv`, and the four-step layering
  order. `Omit<ConfigOutput, 'url'>` stays rejected.
