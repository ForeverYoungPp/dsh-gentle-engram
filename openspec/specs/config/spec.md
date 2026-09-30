# Config Specification

## Purpose

`dsh-gentle-engram` MUST configure itself through the standard Cordis plugin
contract: a single exported `Config` schema that cordis validates and defaults
before `apply` runs, with fail-closed semantics for every invalid value. Today
validation is hand-rolled in `src/config.ts` (`RawEngramConfig`, `DEFAULT_CONFIG`,
`pickNumber` / `pickBoolean` / `pickString`, an unknown-key warning), so a
wrong-typed or out-of-range value is silently replaced by a default and a typo in
`cordis.patch.yml` is only a log line. After this change an invalid value — in
yml or in the environment — aborts plugin load with a named error instead of
loading a plugin whose declared intent was discarded.

`config` is a new capability: no canonical `openspec/specs/config/` spec exists,
so every requirement below is an ADDED requirement (no MODIFIED or REMOVED
operations). Out of scope for this change: releases, publishes, version bumps,
tags, README / `docs/DESIGN.md` / `CONTRIBUTING.md` / `CHANGELOG.md` updates,
config-file discovery, profiles, layered yml merging, hot reload, new config
fields, any `server.ts` / `client.ts` / `tools.ts` behaviour change, coverage
tooling, and new dependencies.

## Requirements

### Requirement: Exported `Config` Schema on the Standard Cordis Plugin Surface

`src/config.ts` MUST declare and `src/index.ts` MUST export a `Config` schema —
a `StandardSchemaV1` built with `@deepseek-ai/schemastery` — describing exactly
the eight existing fields. The module namespace is the plugin object, so `Config`
MUST be reachable as a named export of the plugin entry module, and cordis MUST
be able to validate the user config and apply defaults through it before `apply`
runs. `name`, `inject`, and the `apply(ctx, rawConfig?)` signature MUST NOT
change.

**Acceptance criteria:**

- `Config` is a named export of `src/index.ts` and of `src/config.ts`, and the two are the same value.
- `Config['~standard']` exists (i.e. the export satisfies `StandardSchemaV1`); `src/index.ts` typechecks against cordis's plugin-config expectation.
- The schema declares exactly the eight fields `binary`, `url`, `port`, `captureToolResults`, `capturePrompts`, `requestTimeoutMs`, `startupTimeoutMs`, `fetchMaxAttempts`.
- `src/index.ts` still exports `name === 'dsh-gentle-engram'`, `inject === ['tools']`, and `apply(ctx, rawConfig?)`.
- `pnpm run typecheck` exits 0.

#### Scenario: Cordis can validate and default through the export

- GIVEN the plugin module is imported
- WHEN `Config` is validated against `{}`
- THEN validation succeeds and yields all eight default values
- AND `name`, `inject`, and the `apply` signature are unchanged from before the change

### Requirement: Fail-Closed Validation of Invalid Config Values

Validation MUST reject a wrong-typed, out-of-range, or boundary-violating config
value, so the plugin fails to load instead of substituting a default. No config
value MAY be silently replaced. `binary` MUST be non-blank; every numeric field
MUST stay inside its stated bound.

**Acceptance criteria:**

- Validating `{ port: 99999 }` throws a schemastery `ValidationError`.
- Validating `{ port: 'abc' }` throws a `ValidationError`.
- Validating each out-of-bound numeric value (`port: 0`, `port: 65536`, `requestTimeoutMs: 99`, `requestTimeoutMs: 120001`, `startupTimeoutMs: 499`, `startupTimeoutMs: 300001`, `fetchMaxAttempts: 0`, `fetchMaxAttempts: 9`) throws.
- Validating `{ binary: '' }` and `{ binary: '   ' }` throws.
- Validating a wrong-typed boolean (`{ capturePrompts: 'yes' }`) throws.
- No code path in `src/config.ts` returns the default value for a supplied-but-invalid field.

#### Scenario: Bad yml value aborts load

- GIVEN a config object containing `{ port: 'abc' }`
- WHEN the config is validated
- THEN a `ValidationError` is thrown
- AND no resolved `EngramConfig` with `port: 7437` is produced from that input

#### Scenario: Boundary values still pass

- GIVEN `{ port: 1 }`, `{ port: 65535 }`, `{ requestTimeoutMs: 100 }`, `{ requestTimeoutMs: 120000 }`, `{ startupTimeoutMs: 500 }`, `{ startupTimeoutMs: 300000 }`, `{ fetchMaxAttempts: 1 }`, `{ fetchMaxAttempts: 8 }`
- WHEN each is validated
- THEN validation succeeds and each value is preserved exactly

### Requirement: Field Defaults and Bounds Preserved Exactly

`{}` and `undefined` config MUST resolve to the full pre-change default set, and
each field MUST keep its current default and bound. `cordis.patch.yml` MUST
therefore stay valid without edits.

**Acceptance criteria:**

- Defaults: `binary` `'engram'`, `url` `''` sentinel, `port` `7437`, `captureToolResults` `true`, `capturePrompts` `true`, `requestTimeoutMs` `3000`, `startupTimeoutMs` `10000`, `fetchMaxAttempts` `3`.
- Bounds: `port` 1–65535, `requestTimeoutMs` 100–120000, `startupTimeoutMs` 500–300000, `fetchMaxAttempts` 1–8.
- `resolveConfig({})` and `resolveConfig(undefined)` both deep-equal the eight-value default set (with `url` folded to `undefined`).
- Each default is observable from the schema/`resolveConfig`, not only from a doc comment.

#### Scenario: Empty config fills every default

- GIVEN no config object and no environment variables
- WHEN the config is resolved
- THEN all eight fields equal their tabulated defaults

### Requirement: Non-Integer Numbers Are Rejected

A non-integer numeric value MUST throw. A declared number MUST NOT be altered by
truncation or rounding, and no `Math.trunc`-style coercion MAY survive anywhere in
the config path.

**Acceptance criteria:**

- Validating `{ port: 1.5 }` throws.
- Validating `{ requestTimeoutMs: 3000.5 }` throws.
- `src/config.ts` contains no `Math.trunc` / `Math.round` / `Number.parseInt`-based fallback for a config value.
- `resolveConfig` with a non-integer numeric field throws rather than returning a truncated number.

#### Scenario: Float port fails instead of being truncated

- GIVEN `{ port: 1.5 }`
- WHEN the config is validated
- THEN it throws
- AND no resolved config reports `port === 1`

### Requirement: Unknown Config Keys Must Error

An unrecognised config key MUST abort plugin load with an error naming the key.
A warning-and-continue path MUST NOT remain. Because schemastery returns unknown
keys unchanged, this MUST be an explicit strict key check in the config boundary,
not an assumed property of the schema.

**Acceptance criteria:**

- `resolveConfig({ bogus: 1 })` throws; the thrown message contains `bogus`.
- The schema alone is not relied upon: a test pins that schemastery passes `{ bogus: 1 }` through unchanged, proving the explicit check is load-bearing.
- `resolveConfig` no longer accepts a `warn` parameter, and `src/index.ts` contains no `ctx.logger.warn` call for config keys.
- No unknown-key diagnostic is emitted as a non-fatal warning.

#### Scenario: Typo in cordis.patch.yml fails the load

- GIVEN `{ bogus: 1 }` in the config object
- WHEN the config is resolved
- THEN it throws an error whose message names `bogus`
- AND the plugin does not load with the typo ignored

### Requirement: Environment Variables Keep Precedence Over yml

`ENGRAM_URL`, `ENGRAM_BIN`, and `ENGRAM_PORT` MUST keep overriding the
corresponding yml value, matching the upstream Pi adapter. Schema validation MUST
run before environment layering.

**Acceptance criteria:**

- With `ENGRAM_PORT=1234` and `{ port: 7437 }`, the resolved `port` is `1234`.
- With `ENGRAM_BIN=/usr/local/bin/engram` and `{ binary: 'other' }`, the resolved `binary` is `/usr/local/bin/engram`.
- With `ENGRAM_URL=http://127.0.0.1:9000` and `{ url: 'http://example.test' }`, the resolved `url` is `http://127.0.0.1:9000`.
- Environment variable names and the recognised set are unchanged.
- Yml validation happens first: `{ port: 'abc' }` throws even when `ENGRAM_PORT=1234` is set.

#### Scenario: Environment override wins over yml

- GIVEN `ENGRAM_PORT=1234` and a yml value `{ port: 7437 }`
- WHEN the config is resolved
- THEN the resolved `port` is `1234`

#### Scenario: Environment precedence cannot excuse an invalid yml value

- GIVEN `ENGRAM_PORT=1234` and a yml value `{ port: 'abc' }`
- WHEN the config is resolved
- THEN it throws instead of resolving to `1234`

### Requirement: Malformed Environment Values Fail Closed

A non-blank environment value that cannot be parsed to the field's type, or that
is out of range, MUST abort plugin load with an error naming the offending
variable. It MUST NOT fall back to the yml or default value. A blank or
whitespace-only value MUST still count as unset, exactly as before this change.

**Acceptance criteria:**

- `ENGRAM_PORT=abc` makes resolution throw, and the error message contains `ENGRAM_PORT`.
- `ENGRAM_PORT=99999` makes resolution throw, and the error message contains `ENGRAM_PORT`.
- `ENGRAM_PORT=1.5` makes resolution throw (no `parseInt` truncation to `1`).
- The failure occurs even when a valid yml `port` is present, so a bad override is never mistaken for a working one.
- `ENGRAM_PORT=` (empty) and `ENGRAM_PORT='   '` are treated as unset and do not throw.

#### Scenario: Unparseable env port aborts load

- GIVEN `ENGRAM_PORT=abc` and a valid yml config
- WHEN the config is resolved
- THEN it throws an error naming `ENGRAM_PORT`
- AND no fallback to the yml or default port is used

#### Scenario: Blank env value is still unset

- GIVEN `ENGRAM_PORT=''`
- WHEN the config is resolved
- THEN no error is thrown and the yml or default port applies

### Requirement: `url` Empty-String Sentinel Round-Trip

Schema fields cannot default to `undefined`, so `url` MUST default to the empty
string and the environment-layering step MUST fold that sentinel back to
`string | undefined` in the resolved `EngramConfig`. The fold MUST happen in the
single layering step, and no resolved config MAY expose `''` as its URL, because
the "external server configured ⇒ never spawn or heal a server" branch keys off
`undefined`.

**Acceptance criteria:**

- The resolved `EngramConfig.url` keeps the type `string | undefined`.
- `resolveConfig({})` and `resolveConfig({ url: '' })` both produce `url === undefined`.
- With `ENGRAM_URL=http://127.0.0.1:9000`, the resolved `url` is that defined string.
- With `url: 'http://example.test'` in yml and no `ENGRAM_URL`, the resolved `url` is `http://example.test`.
- No resolved config has `url === ''`.

#### Scenario: Sentinel folds to undefined without an external URL

- GIVEN no `ENGRAM_URL` and no yml `url`
- WHEN the config is resolved
- THEN the resolved `url` is `undefined`
- AND the server-spawning path still treats the server as locally owned

#### Scenario: Configured external URL survives the fold

- GIVEN `ENGRAM_URL=http://127.0.0.1:9000`
- WHEN the config is resolved
- THEN the resolved `url` is exactly `http://127.0.0.1:9000`

### Requirement: Removal of Silent-Fallback Machinery

`RawEngramConfig`, `DEFAULT_CONFIG` as a separate literal, and the
`pickNumber` / `pickBoolean` / `pickString` helpers MUST be removed from
`src/config.ts`. The schema is the single source of truth for defaults.
`EngramConfig` MUST remain the resolved runtime shape, and `resolveConfig` MUST
remain the environment-layering boundary with the order: strict key check →
validated environment precedence → `url` sentinel fold → resolved
`EngramConfig`, replacing the raw type with the schema-inferred type and dropping
the `warn` parameter. All existing call sites MUST be updated in this same change.

**Acceptance criteria:**

- `src/config.ts` exports `EngramConfig`, `Config`, and `resolveConfig`; it exports no `RawEngramConfig`, no standalone `DEFAULT_CONFIG`, and no `pick*` helper.
- `resolveConfig` takes one argument (plus optional raw config) and returns `EngramConfig`.
- Every call site in `src/index.ts`, `src/engram/server.test.ts`, `src/engram/client.test.ts`, and `src/recall-scope.test.ts` compiles against the reduced signature.
- `pnpm run typecheck` exits 0 and `pnpm test` exits 0, with pre-existing tests still green.

#### Scenario: No fallback helper remains in the config path

- GIVEN the applied change
- WHEN `src/config.ts` is read
- THEN no `pickNumber`, `pickBoolean`, or `pickString` declaration exists
- AND no unknown-key warning path exists

#### Scenario: All call sites move with the module

- GIVEN the applied change
- WHEN `pnpm run typecheck` runs
- THEN it exits 0
- AND every `resolveConfig(` call site passes no `warn` callback

### Requirement: Colocated Config Test Coverage

A test file `src/config.test.ts` MUST exist, MUST use only the Node.js standard
library (`node:test`, `node:assert/strict`), and MUST assert this spec's negative
and preserved-behaviour guarantees so `pnpm test` is real evidence rather than
prose.

**Acceptance criteria:**

- `src/config.test.ts` exists, imports only `node:test` / `node:assert` and `src/config.ts` (plus `src/index.ts` for the export check), and adds no dependency.
- It asserts: `{ port: 99999 }` throws, `{ port: 'abc' }` throws, `{ port: 1.5 }` throws, `{ bogus: 1 }` throws, `ENGRAM_PORT=abc` throws, and `ENGRAM_PORT=99999` throws.
- It asserts the default set for `{}` and `undefined`, environment precedence, and the `url` sentinel round-trip.
- Environment mutations are saved and restored per test.
- `pnpm test` exits 0 and its output lists `src/config.test.ts` with passing tests.
- `pnpm run typecheck` exits 0 with the test file in `src/`.

#### Scenario: Fail-closed guarantees are asserted, not described

- GIVEN `src/config.test.ts`
- WHEN `pnpm test` runs
- THEN it exits 0
- AND each negative case above is covered by an explicit `assert.throws`-style assertion

### Requirement: Change Scope Containment

This change MUST be confined to config standardization. It MUST NOT add, remove,
or change a dependency, MUST NOT modify `cordis.patch.yml`, `package.json`
version or `exports`, any workflow, or any documentation, and MUST NOT publish or
release anything.

**Acceptance criteria:**

- `package.json` `dependencies`, `devDependencies`, and `peerDependencies` are byte-identical; `@deepseek-ai/schemastery` stays a devDependency.
- `cordis.patch.yml` is byte-identical.
- No `version` bump, no tag, no publish or workflow change appears in the diff.
- `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `docs/**` are untouched.
- `pnpm run build` exits 0 and the built **runtime** bundle `dist/index.js` remains self-contained (schema inlined, no external import of the schemastery package).
- `dist/index.d.ts` is explicitly excepted from that self-containment. Exporting `Config` on the public surface necessarily references the schema's type, and `@deepseek-ai/schemastery` is a devDependency, so the declaration file keeps a type-only `import Schema from "@deepseek-ai/schemastery"`. Annotating around it is not available either: `@standard-schema/spec` is cordis's dependency, not this package's, and does not resolve here. This is an **accepted, recorded deviation**: the plugin is loaded as a runtime bundle by the harness, so no consumer resolves these types at load time, and this repository itself typechecks with `skipLibCheck: true`.
- The changed-line count stays within the review budget; exceeding it pauses for a delivery decision instead of silently expanding scope.

#### Scenario: Existing config keeps loading untouched

- GIVEN the in-repo `cordis.patch.yml` is unchanged
- WHEN the config block it declares is validated
- THEN validation succeeds and the resolved values match the previous behaviour

#### Scenario: Build stays self-contained at runtime

- GIVEN the applied change
- WHEN `pnpm run build` runs
- THEN it exits 0
- AND the emitted `dist/index.js` contains no bare import of `@deepseek-ai/schemastery`
- AND the type-only import remaining in `dist/index.d.ts` is the recorded, accepted deviation
