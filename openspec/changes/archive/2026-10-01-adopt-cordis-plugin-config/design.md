# Design — adopt-cordis-plugin-config

Status: design
Change: `adopt-cordis-plugin-config`
Store: openspec — `openspec/changes/adopt-cordis-plugin-config/design.md`
Spec: `openspec/changes/adopt-cordis-plugin-config/specs/config/spec.md` (11 requirements, 18 scenarios)
Review size: ~250–300 changed lines (`src/config.ts` rewrite, new `src/config.test.ts`, `src/index.ts` + four test call-site touch-ups) — under the 400-line budget; no `size:exception`, no chaining.

## Design in one paragraph

Replace the hand-rolled `RawEngramConfig` / `DEFAULT_CONFIG` / `pick*` machinery with one
schemastery schema (`FIELDS`) that is simultaneously the Cordis `Config` export, the source of
defaults/bounds, and the validator reused for the environment layer. `resolveConfig` shrinks to a
four-step boundary: **string-key check → schema validate/default → validated env precedence →
`url` sentinel fold**. Cordis validates `Config` before `apply`, so an invalid value never reaches
runtime; `resolveConfig` re-validates so it is also correct when called directly (tests, five call
sites). All four numeric fields use `Schema.natural().min(x).max(y)` (integer + bounds in one
builder), `binary` uses `pattern(/\S/)`, and nothing is ever truncated: `ENGRAM_PORT=1.5` is a
load failure, not a silently altered `1`. No dependency, no `cordis.patch.yml` edit, no docs.

## Settled design questions

The five questions left open by the spec phase are answered here. Each has a rejected
alternative in [Tradeoffs](#tradeoffs).

### Q1 — Integer constraint builders

All four numeric fields use `Schema.natural().min(lo).max(hi).default(d)`:

| Field | Builder |
|---|---|
| `port` | `Schema.natural().min(1).max(65_535).default(7437)` |
| `requestTimeoutMs` | `Schema.natural().min(100).max(120_000).default(3000)` |
| `startupTimeoutMs` | `Schema.natural().min(500).max(300_000).default(10_000)` |
| `fetchMaxAttempts` | `Schema.natural().min(1).max(8).default(3)` |

Why this settles spec requirement 4 (`natural()` source-verified in the installed
`@deepseek-ai/schemastery@3.18.4`, `lib/index.mjs:334`):

- `Schema.natural()` is exactly `Schema.number().step(1).min(0)` — so it is the *same* constraint
  as `z.number().step(1)`, with integer intent in the name.
- `step(1)` rejects non-integers through `isMultipleOf(data, min ?? 0, 1)`, i.e.
  `(data - min) % 1 === 0`. With `min: 1`, `1.5` gives `0.5 % 1 !== 0` → `ValidationError`.
  So `{ port: 1.5 }` throws in the schema itself; no coercion is added anywhere.
- `natural()`'s implicit `min(0)` is **overridden** by the explicit `.min(lo)` (the `min()`
  setter replaces `meta.min`), so `port: 0` fails the bound rather than passing as "natural".
  Omitting `.min()` would silently accept `0` — the explicit `.min()` is mandatory, not cosmetic.
- `natural()` also rejects `NaN` (a numeric `typeof`) via the step check; the environment layer
  additionally guards `Number.isFinite` so the failure message is readable (see Q5).

`Math.trunc` / `Math.round` / `Number.parseInt` do not appear anywhere in the config path. The
only numeric parse is `Number(raw)` for an environment value, immediately followed by validation.

### Q2 — Resolved-type naming and shape

Types at the boundary (all in `src/config.ts`):

| Name | Definition | Who consumes it |
|---|---|---|
| `ConfigInput` | `Schemastery.TypeS<typeof Config>` — schema *input*, every field optional | `resolveConfig(raw?)`; `client.test.ts` helper (replaces `RawEngramConfig`) |
| `ConfigOutput` | `Schemastery.TypeT<typeof Config>` — schema *output*, every field required, `url: string` | `apply(ctx, rawConfig?)` — this is exactly what Cordis hands `apply` after `~standard.validate` |
| `EngramConfig` | unchanged hand-written `interface`, `url: string \| undefined` | `resolveConfig` return; `client.ts`, `server.ts`, `tools.ts` imports — all untouched |

Decisions:

- `EngramConfig` survives **as-is**. It is deliberately *not* derived as
  `Omit<ConfigOutput, 'url'> & { url: string | undefined }`: `Schema.object`'s output type is
  `ObjectT<FIELDS> & Dict`, and `Omit` over that intersection collapses to the `Dict` index
  signature (`keyof` becomes `string | number`), erasing every named field. The explicit
  interface stays the compile-time contract; the schema is the runtime source of truth. Drift is
  caught because `resolveConfig` builds the object literal field-by-field and returns
  `EngramConfig`, so adding a schema field without touching the interface (or vice versa) fails
  the excess/missing-property check in `pnpm run typecheck`.
- `apply` takes `ConfigOutput`, not `ConfigInput`: Cordis validates the schema *before* `apply`,
  so the runtime value is the validated/defaulted output. This is the `Plugin.Object<T>` shape
  (`Config?: StandardSchemaV1<any, T>`, `apply(ctx, config: T)`), so the module namespace stays
  assignable to a Cordis plugin object. We do **not** add a `satisfies Plugin.Object<...>` — the
  installed schemastery types erase `~standard` to bare `StandardSchemaV1.Props`, so such an
  assertion would fail on upstream type imprecision while the runtime contract holds. Alignment is
  enforced by giving `apply` the schema's own output alias.
- `src/index.ts` receives `Config` by re-export (`export { Config } from './config.ts'`), so
  `index.Config === config.Config` — the identity the spec test pins.
- Fallback if TS rejects `ConfigOutput` → `ConfigInput` assignability: widen `resolveConfig`'s
  parameter to `ConfigInput | ConfigOutput | undefined`. It is structurally a superset, so this
  is expected to be unnecessary.

### Q3 — Unknown-key check

**Mechanism:** an explicit diff of the raw input's own keys against the schema's field names,
run **before** schema validation:

```ts
const KNOWN_KEYS = new Set(Object.keys(FIELDS))

function assertKnownKeys(raw: ConfigInput | undefined): void {
  if (raw === undefined) return
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new TypeError(`unknown config key "${key}" (expected one of ${[...KNOWN_KEYS].join(', ')})`)
    }
  }
}
```

- It inspects `Object.keys(raw)` (own enumerable), **not** the validated output. `Object.keys`
  is exact here: Cordis hands `apply` the schema output, and schemastery's object resolver
  (`lib/index.mjs:525` `merge(result, data)`) preserves unknown keys verbatim, so a typo survives
  to `apply` and is caught there. Schema-only implementations silently accept it.
- Comparison target is `Object.keys(FIELDS)`, not a second hand-written list and not
  `Config.dict` (which is typed `Dict<Schema> | undefined`). `FIELDS` is already the schema body,
  so the known set cannot drift from the schema.
- It runs before validation so a typo produces one precise message instead of the schema also
  reporting unrelated default-filled fields.
- Error type is `TypeError`; the message contains the offending key verbatim (`bogus`), satisfying
  spec requirement 5's naming demand. Listing the expected keys is one template string and turns
  the failure into a self-fix instruction.
- `resolveConfig` loses the `warn` parameter; `src/index.ts` loses the
  `message => ctx.logger.warn(...)` arrow. No non-fatal unknown-key path remains.

### Q4 — Test strategy under zero new dependencies

`src/config.test.ts` uses only `node:test` + `node:assert/strict`, per the repo's existing
convention (`pnpm test` = `node --test`, colocated `src/**/*.test.ts`).

| Concern | Mechanism |
|---|---|
| `ValidationError` throws | `assert.throws(() => Config(raw({ port: 99999 })), { name: 'ValidationError' })`. schemastery's `ValidationError extends TypeError` and sets `name = 'ValidationError'`, so the name matcher is stable and does not depend on message wording. |
| Defensive casts | a one-line helper `const raw = (value: Record<string, unknown>): ConfigInput => value as ConfigInput` — it makes the deliberate invalid inputs explicit. `{ bogus: 1 }` needs no cast (`ConfigInput` carries the schemastery `& Dict` index signature); wrong-typed named fields (`{ port: 'abc' }`) do. |
| Defaults | hard-coded `DEFAULTS: EngramConfig` literal as an independent oracle: `assert.deepEqual(resolveConfig(undefined), DEFAULTS)` and `assert.deepEqual(resolveConfig({}), DEFAULTS)` (both keep the `url: undefined` own key). |
| Unknown-key | `assert.equal((Config(raw({ bogus: 1 })) as Record<string, unknown>).bogus, 1)` proves the schema passes it through, then `assert.throws(() => resolveConfig({ bogus: 1 }), /bogus/)` proves the explicit check is load-bearing. |
| Env isolation | one helper sets exactly the named vars and restores in `finally`, deleting `ENGRAM_URL`/`ENGRAM_BIN`/`ENGRAM_PORT` when not named — so ambient shell vars and per-test mutations cannot leak: `withEnv(values, fn)`. `node --test` runs each file in its own process, so nothing leaks across files. |
| Env precedence / malformed env / sentinel | each case wrapped in `withEnv`; malformed cases assert `/ENGRAM_PORT/`; blank/whitespace cases assert the yml value still wins. |
| Export identity | `import { Config as IndexConfig } from './index.ts'` then `assert.equal(IndexConfig, Config)`. Loading `index.ts` is already done by other tests, so this adds no new runtime surface. |

Roughly 12 `test(...)` cases, ~110 lines, covering every negative and preserved-behaviour
acceptance criterion in the spec.

### Q5 — Layering order and its consequences

`resolveConfig` order, with its failure behaviour:

```ts
export function resolveConfig(raw?: ConfigInput): EngramConfig {
  assertKnownKeys(raw)                              // 1. typo → TypeError naming the key
  const validated = Config(raw ?? {})               // 2. invalid yml → ValidationError; {} and undefined fill defaults
  const ymlUrl = validated.url.trim()
  const url = envString('ENGRAM_URL') ?? (ymlUrl === '' ? undefined : ymlUrl)   // 4. sentinel fold (+ blank → unset, as before)
  return {
    binary: envString('ENGRAM_BIN') ?? validated.binary.trim(),
    url,
    port: envPort() ?? validated.port,              // 3. malformed ENGRAM_PORT → TypeError naming the variable
    captureToolResults: validated.captureToolResults,
    capturePrompts: validated.capturePrompts,
    requestTimeoutMs: validated.requestTimeoutMs,
    startupTimeoutMs: validated.startupTimeoutMs,
    fetchMaxAttempts: validated.fetchMaxAttempts,
  }
}
```

```text
raw config ──▶ assertKnownKeys ──▶ Config(raw ?? {}) ──▶ validated ConfigOutput
                    │                     │                       │
                TypeError            ValidationError             │
                (names key)          (names field)               ▼
                                                    envString(BIN/URL) + envPort()
                                                              │  malformed → TypeError (names var)
                                                              ▼
                                                    url sentinel fold ('' → undefined)
                                                              ▼
                                                        EngramConfig
```

Consequences, all deliberate:

1. **Invalid yml fails before env layering.** `{ port: 'abc' }` throws even with
   `ENGRAM_PORT=1234` set (proposal risk 2, spec requirement 6). The env layer never gets the
   chance to mask a declared-but-invalid value. Pinned by a test.
2. **Env values are validated, not coerced.** `envPort()` is the only env parser:

   ```ts
   function envPort(): number | undefined {
     const raw = envString('ENGRAM_PORT')
     if (raw === undefined) return undefined
     const value = Number(raw)
     if (!Number.isFinite(value)) throw new TypeError(`invalid ENGRAM_PORT "${raw}": expected a number`)
     try {
       return FIELDS.port(value)
     } catch (error) {
       throw new TypeError(`invalid ENGRAM_PORT "${raw}": ${error instanceof Error ? error.message : String(error)}`)
     }
   }
   ```

   `Number()` is a parse, not a fallback: `'abc'` → non-finite → named error; `'99999'` and
   `'1.5'` → `FIELDS.port` rejects by bound/step → wrapped with `ENGRAM_PORT`. `parseInt`
   truncation is gone (spec requirement 7).
3. **Blank stays unset.** `envString` is unchanged: it trims and treats blank as absent, so
   `ENGRAM_PORT=''` / `'   '` fall through to yml/default. This is the parent-approved
   exception to fail-closed.
4. **`binary`/`url` env values need no schema pass** — `envString` already guarantees a trimmed
   non-blank string, which is the only constraint `binary` has and there is none on `url`. The
   schema still enforces `binary` non-blank for the yml path via `pattern(/\S/)`.
5. **Normalization is preserved.** The layering step trims `binary` and folds a blank `url` to
   `undefined`, exactly as the old `pickString`/inline-url code did. Only *invalid* input changed
   from "replace with default" to "throw"; whitespace-normalization behaviour is unchanged.
6. **Double validation is intentional.** Cordis validates first; `resolveConfig` re-validates so
   the function is self-contained for its five call sites and the test file. The cost is one
   small-object validation per plugin load.

## Tradeoffs

`openspec/config.yaml` declares `rules.design.require_tradeoffs: true`; each choice below was
weighed against the alternatives actually available.

| # | Decision | Rejected alternative(s) | Why the alternative lost | Accepted cost |
|---|---|---|---|---|
| T1 | Adopt a schemastery `Config` and delete `RawEngramConfig` / `DEFAULT_CONFIG` / `pick*` | Keep hand-rolled `pick*` and add bounds checks | Duplicates the platform contract Cordis already applies before `apply`; two validators drift; the fallback-is-the-bug behaviour that motivated the change survives | Rewrite of `src/config.ts` and a new test file; a schema layer to learn |
| T2 | Integer bounds via `Schema.natural().min(x).max(y)` | `Schema.number().step(1).min(x).max(y)` | Identical runtime constraint (natural *is* `number().step(1).min(0)`), but "natural" is the only one that names integer intent and catches `NaN` without a separate guard | Implicit `min(0)` must be overridden by an explicit `.min()` — a trap a reviewer must notice |
| T3 | …and rejecting non-integers instead of truncating | `Schema.number().transform(v => Math.trunc(v))`, or `pickNumber`'s old `Math.trunc` | Silently altering a declared number is the same invisible corruption the change exists to remove; spec requirement 4 forbids it | A previously tolerated `port: 1.5` now fails the load (intended) |
| T4 | Unknown-key diff on raw `Object.keys` vs `Object.keys(FIELDS)`, before validation | Rely on the schema alone; hand-written key array; check the validated output; post-validation check | The schema provably passes unknown keys through (`merge` at `lib/index.mjs:525`), so schema-only is not strict; a second key array can drift from the schema; the validated output also contains the unknown keys, so pre- vs post-validation only changes which message a user sees first | ~6 lines + a test that pins the pass-through |
| T5 | `EngramConfig` stays a hand-written interface; `ConfigInput` / `ConfigOutput` alias the schema's input/output | `type EngramConfig = Omit<ConfigOutput, 'url'> & { url: string \| undefined }` | `Schema.object`'s output is `ObjectT<X> & Dict`; `Omit` over the intersection collapses to the index signature and erases every named field | Field names appear in both the schema and the interface; parity is enforced by the `resolveConfig` return type, not by derivation |
| T6 | `apply(ctx, config?: ConfigOutput)`; no `satisfies Plugin.Object<...>` | Annotate/assert the module against cordis's `Plugin.Object<T>` | Installed schemastery erases `~standard` to untyped `StandardSchemaV1.Props`, so the assertion would fail on upstream imprecision, not on our types; a failing assertion would be noise, not evidence | Type-level Cordis conformance is by construction, not machine-asserted |
| T7 | Keep `resolveConfig` as the single boundary and re-validate inside it | Split into `parseConfig` (schema) + `layerEnv`; or trust Cordis and skip yml validation in `resolveConfig` | A split is a new internal API for one caller; skipping validation makes `resolveConfig({ port: 1.5 })` return a config, violating spec requirement 4 and making the module untestable in isolation | One extra validation per load (negligible) |
| T8 | Env port parsing with `Number()` + schema, wrapped in a named `TypeError` | `Number.parseInt(raw, 10)` + range check (old), or re-running the full schema on a merged `{...raw, ...env}` object | `parseInt` truncates (`1.5 → 1`) and `abc → NaN` silently; merging before validating lets a valid env value excuse an invalid yml value, contradicting spec requirement 6 | Two validation passes when an env override exists |
| T9 | `binary` non-blank via `pattern(/\S/)`, no schema transform | Anchored no-padding regex `^\S(?:.*\S)?$`; `transform(s => s.trim())` | The anchored regex rejects previously-trimmed-but-valid inputs (`' engram '`) — a new failure mode the spec does not ask for; the transform re-introduces a silent value alteration inside the schema | Whitespace padding in a yml `binary` is trimmed in the layering step (unchanged behaviour), so no user-visible change |
| T10 | Fail-closed errors: schemastery `ValidationError` for yml, `TypeError` naming key/variable for the boundary checks | A bespoke error class hierarchy; reusing `ValidationError` for env errors | One error class with no additional callers is speculative; the spec only requires a named message. `TypeError` is consistent with schemastery's own error base | Callers that want to catch config errors match on message/name rather than one class |
| T11 | In-process env save/restore helper in `config.test.ts` | Spawning a child process per env case; `--env-file`; mutating env without restore | Per-case processes add test infrastructure for no isolation benefit (`node --test` already forks per file); un-restored env leaks across cases in the same file and hides ordering bugs | Every env-sensitive test must opt into `withEnv`; a forgotten wrap could read ambient env |
| T12 | Store field definitions in one `FIELDS` object used for schema, known-key set, and env validation | Separate schema literal + separate key list + per-field env validators | Three sources of truth for the same eight fields is exactly the drift this change removes | `FIELDS` is a new module-private abstraction, justified by three real consumers |

## Contracts

| Contract | Definition |
|---|---|
| Schema export | `Config` is a `StandardSchemaV1` built with `@deepseek-ai/schemastery`; re-exported by `src/index.ts`, so `index.Config === config.Config`. |
| Field contract | exactly eight fields: `binary`, `url`, `port`, `captureToolResults`, `capturePrompts`, `requestTimeoutMs`, `startupTimeoutMs`, `fetchMaxAttempts`; defaults `'engram'`, `''`, `7437`, `true`, `true`, `3000`, `10000`, `3`; bounds `1–65535`, `100–120000`, `500–300000`, `1–8`. |
| Frozen surface | `name === 'dsh-gentle-engram'`, `inject === ['tools']`, `apply(ctx, rawConfig?)` — arity and behaviour unchanged. |
| `resolveConfig(raw?)` | one parameter (no `warn`); returns `EngramConfig`; order = key check → schema validate/default → env precedence → `url` fold. |
| Failure contract | invalid yml → schemastery `ValidationError`; unknown key → `TypeError` naming the key; malformed env → `TypeError` naming `ENGRAM_PORT`. No path substitutes a default for a supplied-but-invalid value. |
| Sentinel contract | `Config`'s `url` defaults to `''`; `EngramConfig.url` is `string \| undefined`; no resolved config has `url === ''`. |
| Unknown-key contract | the schema alone does not reject unknown keys; `assertKnownKeys` is the only rejector, and a test pins the schema's pass-through. |
| Test contract | `src/config.test.ts`, stdlib only, env mutated only via a restoring helper, `pnpm test` exit 0. |
| Packaging contract | no dependency change; tsdown inlines the devDependency schema (`dist/` self-contained, no bare `@deepseek-ai/schemastery` import); `cordis.patch.yml` byte-identical. |

## File changes

| File | Change | Notes |
|---|---|---|
| `src/config.ts` | Rewrite: add `FIELDS`, `Config`, `ConfigInput`, `ConfigOutput`; remove `RawEngramConfig`, `DEFAULT_CONFIG`, `pick*`; keep `EngramConfig` and `engramAuthToken`; `resolveConfig` = key check + schema + env + fold | ~70–85 lines |
| `src/config.test.ts` | New colocated stdlib test: fail-closed negatives, boundaries, defaults, unknown-key, env precedence, malformed env, sentinel, export identity | ~100–120 lines |
| `src/index.ts` | Import `resolveConfig` + `type ConfigOutput`; `export { Config } from './config.ts'`; `apply(ctx, rawConfig?: ConfigOutput)`; `resolveConfig(rawConfig)` | ~4 lines |
| `src/engram/server.test.ts` (`:102`) | `resolveConfig(undefined, () => {})` → `resolveConfig(undefined)` | 1 line |
| `src/engram/client.test.ts` (`:5`, `:66–67`, `:380`) | `RawEngramConfig` → `type ConfigInput`; `resolveConfig(raw, () => {})` → `resolveConfig(raw)`; `resolveConfig(undefined, () => {})` → `resolveConfig(undefined)` | 3 lines |
| `src/recall-scope.test.ts` (`:59`) | `resolveConfig(undefined, () => {})` → `resolveConfig(undefined)` | 1 line |

Not touched: `cordis.patch.yml` (every schema field has a default; its three keys stay valid),
`package.json`, `tsconfig.json`, `tsdown.config.ts`, `README.md`, `docs/**`, workflows, version.

## TDD ordering (strict TDD is on)

1. **RED:** add `src/config.test.ts` first. `import { Config } from './config.ts'` resolves to
   `undefined` against the current module, so the schema cases throw `TypeError: Config is not a
   function` and `pnpm test` fails; `pnpm run typecheck` fails on the missing export and the
   one-argument `resolveConfig` calls.
2. **GREEN:** rewrite `src/config.ts`, then update `src/index.ts` and the four call sites in the
   same commit (the signature change does not typecheck otherwise).
3. **Evidence:** `pnpm test` output naming `src/config.test.ts` with all cases passing;
   `pnpm run typecheck` exit 0; `pnpm run build` exit 0 with `dist/index.js` containing no bare
   `@deepseek-ai/schemastery` import.

## Rollback

One commit, no runtime data or published-artifact blast radius. `git revert` restores
`RawEngramConfig` / `DEFAULT_CONFIG` / `pick*` and the two-argument `resolveConfig`; delete
`src/config.test.ts`. `pnpm run typecheck && pnpm test` returns to the pre-change green state.
No config file, dependency, environment variable, or published package is mutated by this change.

## Review checklist

- [ ] `src/config.ts` exports `Config`, `EngramConfig`, `resolveConfig`; no `RawEngramConfig`,
      no standalone `DEFAULT_CONFIG`, no `pick*`, no `Math.trunc` / `parseInt`.
- [ ] `Config` re-exported from `src/index.ts`; `index.Config === config.Config`.
- [ ] All four numeric fields use `Schema.natural().min(...).max(...)`; `binary` uses `pattern(/\S/)`.
- [ ] `resolveConfig` takes one parameter, order is key check → schema → env → fold.
- [ ] `{ port: 99999 }`, `{ port: 'abc' }`, `{ port: 1.5 }`, `{ binary: '   ' }`, `{ bogus: 1 }`,
      `ENGRAM_PORT=abc`, `ENGRAM_PORT=99999`, `ENGRAM_PORT=1.5` each throw.
- [ ] `{}` / `undefined` give the default set; `ENGRAM_*` still override; `url` sentinel folds.
- [ ] `src/config.test.ts` uses only `node:test` / `node:assert`, mutates env only via a restoring
      helper, and `pnpm test` names it as passing.
- [ ] `cordis.patch.yml`, `package.json` dependencies, docs, workflows, version untouched.
- [ ] `pnpm run build` emits a self-contained `dist/` with no bare schemastery import.

## Out of scope (scope guard)

Publish/release/version/tag; README, `docs/DESIGN.md`, `CONTRIBUTING.md`, `CHANGELOG.md`; any
`cordis.patch.yml` edit; dependency additions or removals; config-file discovery, profiles,
layered yml merging, hot reload, new fields; changes to `server.ts` / `client.ts` / `tools.ts`
behaviour; coverage tooling or new test frameworks.
