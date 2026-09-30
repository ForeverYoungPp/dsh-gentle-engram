# Proposal — adopt-cordis-plugin-config

Status: proposal (awaiting review)
Change: `adopt-cordis-plugin-config`
Store: openspec — `openspec/changes/adopt-cordis-plugin-config/proposal.md`
Source: parent-confirmed product decisions + parent-verified technical context (DSH 0.2.0-rc.2). No `exploration.md` exists for this change.
Review size: ~250–300 changed lines expected (one module rewrite, one new colocated test file, four call-site touch-ups) — under the 400-line budget; no `size:exception`, no chaining.

## Problem statement

`dsh-gentle-engram` configures itself through hand-rolled validation in `src/config.ts`:
`RawEngramConfig` (8 `unknown` fields), `DEFAULT_CONFIG`, `pickNumber` / `pickBoolean` /
`pickString`, and an unknown-key warning behind `resolveConfig(raw, warn)`. Three costs follow.

1. **Invalid config does not fail.** A wrong-typed or out-of-range value (`port: 'abc'`,
   `port: 99999`) is silently replaced by the default. The plugin loads looking healthy while
   the operator's declared intent is thrown away — the worst possible failure mode for a
   memory plugin whose misconfiguration is invisible until data lands in the wrong place.
2. **Typos are advisory.** `{ bogus: 1 }` in `cordis.patch.yml` produces a log warning and
   continues, so a misspelled key is a silent no-op unless someone reads the logs.
3. **The plugin does not use the platform contract.** DSH's loader treats the module namespace
   as the plugin object and cordis validates `Config` (a `StandardSchemaV1`) and applies
   defaults **before** `apply` is called. Hand-rolled validation duplicates that mechanism,
   drifts from it, and denies users the harness's own config validation and error reporting.

The rest of the standard surface is already compliant (`export const name`,
`export const inject = ['tools']`, `apply(ctx: Context, rawConfig?)`); the missing piece is the
`Config` export and the validation semantics that come with it.

## Intent

Make `Config` the single source of truth for plugin configuration: declared as a schemastery
schema, exported as part of the standard Cordis plugin surface, validated and defaulted by
cordis before `apply` runs, with fail-closed semantics for invalid values and unknown keys, and
environment variables retaining their existing precedence over yml.

Nothing else about the plugin changes. No release, no publish, no version bump.

## Confirmed product decisions (recorded as assumptions — not re-litigated)

| # | Decision | Consequence in this proposal |
| --- | --- | --- |
| 1 | **Invalid config fails closed.** Out-of-range or wrong-typed values make the plugin fail to load with a validation error; no silent fallback to defaults. | Schema constraints carry real bounds; the `pick*` fallback helpers are removed, not kept as a second path. |
| 2 | **Unknown config keys must error, not warn.** schemastery passes unknown keys through unchanged, so this needs an explicit strict check beyond the schema. | A strict key check is part of the config boundary and is covered by a test that `{ bogus: 1 }` throws. The `warn` diagnostic sink is no longer needed for config. |
| 3 | **Environment variables win over yml.** `ENGRAM_URL` / `ENGRAM_BIN` / `ENGRAM_PORT` keep overriding the yml value, unchanged, matching the upstream Pi adapter. | Schema validation runs before environment layering; the layering step is preserved as-is. |
| 4 | **First slice = Config standardization only.** README/CHANGELOG updates, version bumps, and release work are non-goals and belong to separate changes. | This change touches no docs, no version, no workflow. |

## Approach

**Target shape of `src/config.ts`:**

| Element | Change |
| --- | --- |
| `Config` | **New export** — schemastery schema built from the eight existing fields, each with the current default, so `cordis.patch.yml` stays valid without edits. |
| `RawEngramConfig` | **Removed** — replaced by the schema's inferred type. |
| `DEFAULT_CONFIG` | **Removed** as a separate literal; the defaults live in the schema. |
| `pickNumber` / `pickBoolean` / `pickString` | **Removed** — schema constraints and casts replace them, and they were the mechanism of silent fallback. |
| unknown-key warning | **Replaced** by a strict check that throws. |
| `EngramConfig` | **Kept** — the resolved runtime shape consumed by the rest of the plugin. |
| `resolveConfig` | **Kept as the environment-layering boundary**, reduced to: strict key check → **validated** env precedence (a malformed env value throws) → `url` sentinel fold → resolved `EngramConfig`. Its `warn` parameter is dropped because unknown keys now throw instead of warn. |

**Field contract carried over from today's behaviour (defaults and bounds preserved exactly):**

| Field | Type | Default | Bound |
| --- | --- | --- | --- |
| `binary` | string | `'engram'` | non-blank |
| `url` | string | `''` sentinel | folds to `string \| undefined` |
| `port` | number | `7437` | 1–65535 |
| `captureToolResults` | boolean | `true` | — |
| `capturePrompts` | boolean | `true` | — |
| `requestTimeoutMs` | number | `3000` | 100–120000 |
| `startupTimeoutMs` | number | `10000` | 500–300000 |
| `fetchMaxAttempts` | number | `3` | 1–8 |

**The `url` sentinel is required, not cosmetic.** Schema fields cannot default to `undefined`,
so `url` defaults to `''` and the environment-layering step folds the empty string back to
`string | undefined` — this preserves the "external URL configured ⇒ never spawn or heal a
server" branch, which keys off `undefined`.

**Platform mechanism does the heavy lifting.** cordis validates `Config` and applies defaults
before `apply`, so `{ port: 99999 }` and `{ port: 'abc' }` surface as `ValidationError` at load
(parent-verified against the installed `@deepseek-ai/schemastery@~3.18.4`). `resolveConfig`
performs the part the schema cannot: rejecting unknown keys (schemastery returns them
unchanged) and applying environment precedence.

**Environment values fail closed too.** The same rule extends to the environment layer: a value
that cannot be parsed or is out of range (`ENGRAM_PORT=abc`, `ENGRAM_PORT=99999`) aborts plugin
load instead of silently falling back to the yml or default value, so a bad override can never
be mistaken for a working one.

**Dependency position is unchanged.** `@deepseek-ai/schemastery@~3.18.4` is already a
devDependency, tsdown bundles devDependencies, and a probe build confirmed the schema is inlined
with no external import (35 kB / 9.25 kB gzip). The published tarball therefore stays
self-contained; `package.json` gains no dependency.

## Scope

**In scope (exact file list):**

| File | Change | Rough lines |
| --- | --- | --- |
| `src/config.ts` | `Config` schema export; remove `RawEngramConfig` / `DEFAULT_CONFIG` / `pick*` / unknown-key warning; strict key check + env layering in `resolveConfig` | ~60–80 |
| `src/config.test.ts` | **New** colocated test — fail-closed negatives, defaults, unknown-key rejection, env precedence, `url` sentinel | ~80–120 |
| `src/index.ts` | Export `Config`; call `resolveConfig` without the `warn` sink | ~4 |
| `src/engram/server.test.ts` (line 102), `src/engram/client.test.ts` (lines 66, 380), `src/recall-scope.test.ts` (line 59) | Call-site updates for the reduced `resolveConfig` signature | ~6 |

**Explicit non-goals:**

- **No publish, no release.** No `prepublishOnly` change, no `publish.yml` change, no tarball
  push, no version bump, no tag. Publishing is a human decision taken after in-DSH testing.
- `README.md` / `docs/DESIGN.md` / `CONTRIBUTING.md` / `CHANGELOG.md` updates — separate changes.
- `cordis.patch.yml` edits — verified unnecessary, since every schema field carries a default.
- The rest of the standard plugin surface (`name`, `inject`, `apply` signature) — already
  compliant since commit `15703ac`.
- Environment variable **names, precedence, or the set of recognised variables** for
  `ENGRAM_URL` / `ENGRAM_BIN` / `ENGRAM_PORT` / `ENGRAM_HTTP_TOKEN`. Their *malformed-value*
  handling does change and is in scope: an unparseable or out-of-range environment value now
  fails closed like a yml value.
- Config file discovery, profiles, layered yml merging, hot reload, new config fields.
- Any `server.ts` / `client.ts` / `tools.ts` behaviour change.
- Coverage tooling, new test frameworks, or new dependencies of any kind.

## Affected areas

| Area | Impact | Evidence of containment |
| --- | --- | --- |
| Plugin load path | Behaviour change: invalid config now aborts load with a validation error instead of loading with defaults | Verified schemastery runtime behaviour; new negative tests |
| Operator experience | Typos and bad values become hard failures with a message, visible at load — in yml **and** in the environment | Decisions 1, 2, and 3; `cordis.patch.yml` unchanged so current valid configs keep loading |
| `src/config.ts` public shape within the repo | `RawEngramConfig` / `DEFAULT_CONFIG` / `pick*` disappear; `resolveConfig` loses its `warn` parameter | `config.ts` is not a package export (`exports` maps `.` only); all 5 call sites are updated in the same change |
| Tests | 4 existing files touched at 5 call sites; 1 new test file | Mechanical edits only, no assertion-semantics change |
| Published tarball | No change to dependency set or external imports | Probe build: schema inlined, 35 kB / 9.25 kB gzip, no external import |

## Risks and how this proposal handles them

**1. Fail-closed is a visible behaviour change for existing users.** A user with a
currently-silently-ignored bad value (`port: 'abc'`) will now fail to load after upgrading.
Handling: this is the explicit product decision (1), the failure message names the offending
field, and `cordis.patch.yml` in-repo is already valid. The change is revertible in one commit
if the failure proves too sharp.

**2. Environmental precedence cannot excuse an invalid yml value.** Schema validation runs
before environment layering, so `port: 'abc'` in yml throws even when `ENGRAM_PORT` would
override it. Handling: treated as intended fail-closed behaviour, documented as a stated
consequence here so it is not rediscovered as a surprise; a test pins it.

**3. Unknown-key rejection is only as strict as the explicit check.** schemastery passes
unknown keys through unchanged, so a schema-only implementation would silently accept typos.
Handling: the strict check is a named, tested part of the config boundary, with `{ bogus: 1 }`
as a required negative test — not an emergent property of the schema.

**4. Numeric casting gap versus today's `Math.trunc`.** `pickNumber` truncated floats
(`port: 1.5` → `1`), which silently altered a declared number. Handling: **decided — reject**.
Non-integer values throw, no coercion is reintroduced as a schema cast, and the exact constraint
builder is settled at design time and pinned by a test.

**5. Bundling assumption could rot later.** The published package stays dependency-free only
while tsdown inlines devDependencies. Handling: the proposal records the probe evidence, adds no
dependency, and keeps `package.json` untouched — so if a later change externalizes devDeps, the
break is visibly a packaging change, not a silent tarball bug.

**6. `url` sentinel could leak `''` downstream.** A raw empty string reaching server logic would
be truthy in a `!== undefined` check and wrongly suppress server spawning. Handling: the fold
lives in the single environment-layering step, the resolved `EngramConfig.url` keeps its
`string | undefined` type, and the sentinel round-trip is a required test case.

**7. A malformed environment variable now blocks plugin load.** `ENGRAM_PORT=abc` was silently
ignored and is now fatal, so a stale exported variable — from an outer shell, a container image,
or a test harness — turns into a plugin load failure. Handling: this is the confirmed product
decision, and it is the same fail-closed rule applied consistently rather than half-applied;
environment precedence itself is unchanged, and the failure message names the variable so the
cause is one line away.

## Rollback

Single revertible commit, no runtime data or published-artifact blast radius:

1. `git revert` the change commit(s).
2. `src/config.ts` returns to `RawEngramConfig` / `DEFAULT_CONFIG` / `pick*` / warning-based
   `resolveConfig`; `src/config.test.ts` is deleted; `src/index.ts` and the four test call sites
   return to the two-argument `resolveConfig`.
3. `pnpm run typecheck && pnpm test` should return to the pre-change green state without further
   edits.

No config file, dependency, environment variable, or published package is created or mutated by
this change, so rollback has no external effect. Nothing was published, so there is nothing to
un-publish.

## Success criteria

**Fail-closed (the core behaviour change):**

- `Config` is exported from the plugin module and is a `StandardSchemaV1` that cordis validates
  before `apply`.
- `{ port: 99999 }` and `{ port: 'abc' }` each produce a `ValidationError` — asserted
  directly against the schema, so the guarantee does not depend on a live DSH load.
- `{ bogus: 1 }` throws instead of warning or being ignored.
- A malformed environment value (`ENGRAM_PORT=abc`) and an out-of-range one (`ENGRAM_PORT=99999`)
  each abort with a named error instead of falling back to the yml or default value.
- `{ port: 1.5 }` throws; no `Math.trunc`-style coercion survives anywhere in the config path.
- No silent-fallback helper remains: `pickNumber` / `pickBoolean` / `pickString` are gone from
  `src/config.ts`.

**Preserved behaviour:**

- `{}` and `undefined` resolve to the full default set (all eight fields, exact current values).
- `ENGRAM_URL` / `ENGRAM_BIN` / `ENGRAM_PORT` still override yml values, pinned by tests.
- The `url` empty-string sentinel folds back to `undefined`, and an environment `ENGRAM_URL`
  still produces a defined URL.
- Every field keeps its current default and bound, as tabulated above.

**Delivery and hygiene:**

- `pnpm test` passes (new `src/config.test.ts` green, all pre-existing tests still green) and
  `pnpm run typecheck` passes.
- `cordis.patch.yml` is byte-identical — the existing config block still validates.
- `package.json` `dependencies` / `devDependencies` are unchanged; no new dependency.
- `pnpm run build` keeps `dist/` self-contained (`index.js` + `index.d.ts`, schema inlined).
- No publish, release, version bump, or workflow change exists in the diff.
- Review size stays under the 400-line budget; if the diff exceeds it, delivery pauses and asks
  (ask-on-risk) rather than opening a chain silently.

**Human gate after this change (not part of the change):** the user loads the built plugin
inside DSH (DeepSeek Harness) and exercises it manually. Publishing stays a human decision taken
only after that test, and is out of scope here.

## Proposal question round — resolved

The two points raised after drafting were answered by the user in this session. Both resolve
fail-closed, extending decision 1 to the environment layer rather than leaving it half-applied.

1. **Malformed environment values fail closed.** `ENGRAM_PORT=abc`, an out-of-range
   `ENGRAM_PORT=99999`, or any unparseable environment value aborts plugin load with a named
   error instead of being silently ignored and falling back to the yml or default value.
   Rationale: the silent fallback is the exact failure mode this change removes from yml, and
   applying it to only one of the two configuration sources would leave the bug reachable.
   Environment **precedence** is unchanged (decision 3); only malformed-value handling changes.
2. **Non-integer numbers are rejected.** `port: 1.5` throws instead of being truncated to `1`.
   Rationale: silently altering a declared number is the same class of invisible corruption as a
   silent fallback, so `Math.trunc`-style coercion is not reintroduced as a schema cast.

Both are settled; nothing here remains open.
