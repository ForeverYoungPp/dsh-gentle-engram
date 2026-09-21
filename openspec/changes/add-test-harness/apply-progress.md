# Apply Progress — add-test-harness

Status: in progress — work unit 1 of 3 complete; work units 2 and 3 pending.
Change: `add-test-harness`
Store: openspec — `openspec/changes/add-test-harness/apply-progress.md`
Spec: `openspec/changes/add-test-harness/specs/testing/spec.md`
Design: `openspec/changes/add-test-harness/design.md` (authoritative for commit boundaries, contracts, negative-control record shape, and the CI contingency ladder)

## Structured status consumed

Native `gentle-ai.sdd-status` v2: `changeName: add-test-harness`, `artifactStore: openspec`,
`nextRecommended: apply`, `applyState: ready`, `dependencies.apply: ready`, `blockedReasons: []`,
`actionContext.mode: repo-local`, `workspaceRoot`/`allowedEditRoots`:
`/home/fy/Projects/code/dsh-gentle-engram`. Every edit stayed inside the allowed root.
Strict TDD is not active for this run by design (`openspec/config.yaml` still reads
`strict_tdd: false`); task 3.1 flips it last, and the bootstrap exception below is recorded for `sdd-verify`.

## Work unit 1 — Node stdlib harness + pilot redaction test

Tasks completed in this unit, each marked in `tasks.md` immediately after its outcome was
observed: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10.
Commit: work-unit commit 1 ("test: add Node stdlib test harness with pilot redaction test");
its SHA is recorded in the final apply report (a commit cannot record its own id).

Files changed by this unit:
- `package.json` — `scripts.test` and `engines.node` only (below).
- `src/redaction.test.ts` — new pilot test, 6 `test(...)` cases covering all four exports.
- `.pi-lens.json` — pre-existing untracked repo-local tooling config, committed here per design.
- planning artifacts (`exploration.md`, `proposal.md`, `design.md`, `tasks.md`, `specs/testing/spec.md`)
  and this `apply-progress.md`, staged in commit 1 per the design's commit plan.

### `package.json` diff summary (task 1.1)

`git diff package.json` as staged in work unit 1:

```diff
diff --git a/package.json b/package.json
index 9753c73..1403643 100644
--- a/package.json
+++ b/package.json
@@ -3,6 +3,9 @@
   "version": "0.2.0",
   "type": "module",
   "packageManager": "pnpm@10.15.0",
+  "engines": {
+    "node": ">=22.18"
+  },
   "description": "HTTP-native Engram persistent memory integration for DeepSeek Harness",
   "main": "dist/index.js",
   "types": "dist/index.d.ts",
@@ -45,6 +48,7 @@
   "scripts": {
     "build": "tsdown",
     "typecheck": "tsc -p tsconfig.json",
+    "test": "node --test",
     "prepublishOnly": "pnpm run typecheck && pnpm run build"
   },
   "peerDependencies": {
```

Unchanged, quoted verbatim from `package.json` (lines 21–28 and 52):
- `"files": [ "dist", "cordis.patch.yml", "README.md", "DESIGN.md", "PI-PORT.md", "LICENSE" ]`
  — neither `src` nor any `*.test.*` path.
- `"prepublishOnly": "pnpm run typecheck && pnpm run build"` — no test command added.
- `dependencies` (absent), `peerDependencies`, `devDependencies` — no diff hunk touches them.

### Green focused transcript (task 1.3)

Command: `node --test src/redaction.test.ts`

```text
✔ redactPrivateTags replaces multiple private blocks (0.74754ms)
✔ redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone (0.098383ms)
✔ redactUrlPath redacts a percent-encoded private query value and preserves URL shape (0.195082ms)
✔ redactUrlPath redacts a private block in a path segment (0.099702ms)
✔ redactValue redacts nested strings and passes non-string primitives through (0.490663ms)
✔ redactText redacts then trims surrounding whitespace (0.078599ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 70.119624
exit=0
```


Exit 0; `tests 6`, `pass 6`, `fail 0`.

### Canonical green transcript (task 1.6)

Command: `pnpm test` (canonical, no file path)

```text

> dsh-gentle-engram@0.2.0 test /home/fy/Projects/code/dsh-gentle-engram
> node --test

✔ redactPrivateTags replaces multiple private blocks (0.820625ms)
✔ redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone (0.09791ms)
✔ redactUrlPath redacts a percent-encoded private query value and preserves URL shape (0.185225ms)
✔ redactUrlPath redacts a private block in a path segment (0.100722ms)
✔ redactValue redacts nested strings and passes non-string primitives through (0.520937ms)
✔ redactText redacts then trims surrounding whitespace (0.086834ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 79.231527
exit=0
```

Exit 0; `tests 6`, `pass 6`, `fail 0`.

### Discovery naming transcript (task 1.6)

Node 26.9.0's reporters (default/spec and tap) elide the per-file header when the only test
file is green, so the canonical script is run once more with the built-in JUnit reporter
(no path argument — same discovery, output names the file). This run also proves every
passing testcase comes from `src/redaction.test.ts`, the only `*.test.*` file in the repo
(`find src -name '*.test.*'` → `src/redaction.test.ts`).

Command: `pnpm test --test-reporter=junit`

```text

> dsh-gentle-engram@0.2.0 test /home/fy/Projects/code/dsh-gentle-engram
> node --test --test-reporter=junit

<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="redactPrivateTags replaces multiple private blocks" time="0.000737" classname="test" file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"/>
	<testcase name="redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone" time="0.000094" classname="test" file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"/>
	<testcase name="redactUrlPath redacts a percent-encoded private query value and preserves URL shape" time="0.000192" classname="test" file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"/>
	<testcase name="redactUrlPath redacts a private block in a path segment" time="0.000115" classname="test" file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"/>
	<testcase name="redactValue redacts nested strings and passes non-string primitives through" time="0.000495" classname="test" file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"/>
	<testcase name="redactText redacts then trims surrounding whitespace" time="0.000081" classname="test" file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"/>
	<!-- tests 6 -->
	<!-- suites 0 -->
	<!-- pass 6 -->
	<!-- fail 0 -->
	<!-- cancelled 0 -->
	<!-- skipped 0 -->
	<!-- todo 0 -->
	<!-- duration_ms 80.607492 -->
</testsuites>
exit=0
```

Exit 0; six `file="/home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts"` testcases;
`pass 6`, `fail 0`.

## Negative control (proves the harness can fail)

Command: pnpm test            (focused: node --test src/redaction.test.ts)
File/line: src/redaction.test.ts:8
Original assertion:   assert.equal(redactPrivateTags(input), 'a [REDACTED] b [REDACTED] c')
Inverted assertion:   assert.equal(redactPrivateTags(input), input)
Observed (inverted, focused):   exit 1 — redactPrivateTags replaces multiple private blocks — AssertionError pasted verbatim below
Observed (inverted, canonical): exit 1 — redactPrivateTags replaces multiple private blocks — AssertionError pasted verbatim below
Observed (reverted): exit 0 — pass 6, fail 0
Final-tree check: `assert.equal(redactPrivateTags(input), input)` absent from src/redaction.test.ts (`grep -n "redactPrivateTags(input), input)" src/redaction.test.ts` → no match, exit 1)

### Inverted focused run, verbatim (task 1.4)

Command: `node --test src/redaction.test.ts`

```text
✖ redactPrivateTags replaces multiple private blocks (2.726852ms)
✔ redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone (0.257408ms)
✔ redactUrlPath redacts a percent-encoded private query value and preserves URL shape (0.386203ms)
✔ redactUrlPath redacts a private block in a path segment (0.243753ms)
✔ redactValue redacts nested strings and passes non-string primitives through (1.114143ms)
✔ redactText redacts then trims surrounding whitespace (0.179536ms)
ℹ tests 6
ℹ suites 0
ℹ pass 5
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 87.906408

✖ failing tests:

test at src/redaction.test.ts:6:1
✖ redactPrivateTags replaces multiple private blocks (2.726852ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'a [REDACTED] b [REDACTED] c'
  - 'a <private>x</private> b <private>y</private> c'
       ^
  
      at TestContext.<anonymous> (file:///home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts:8:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'a [REDACTED] b [REDACTED] c',
    expected: 'a <private>x</private> b <private>y</private> c',
    operator: 'strictEqual',
    diff: 'simple'
  }
exit=1
```

### Inverted canonical run, verbatim (task 1.4)

Command: `pnpm test`

```text

> dsh-gentle-engram@0.2.0 test /home/fy/Projects/code/dsh-gentle-engram
> node --test

✖ redactPrivateTags replaces multiple private blocks (1.273981ms)
✔ redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone (0.141622ms)
✔ redactUrlPath redacts a percent-encoded private query value and preserves URL shape (0.190429ms)
✔ redactUrlPath redacts a private block in a path segment (0.098385ms)
✔ redactValue redacts nested strings and passes non-string primitives through (0.513473ms)
✔ redactText redacts then trims surrounding whitespace (0.089772ms)
ℹ tests 6
ℹ suites 0
ℹ pass 5
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 80.045733

✖ failing tests:

test at src/redaction.test.ts:6:1
✖ redactPrivateTags replaces multiple private blocks (1.273981ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'a [REDACTED] b [REDACTED] c'
  - 'a <private>x</private> b <private>y</private> c'
       ^
  
      at TestContext.<anonymous> (file:///home/fy/Projects/code/dsh-gentle-engram/src/redaction.test.ts:8:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'a [REDACTED] b [REDACTED] c',
    expected: 'a <private>x</private> b <private>y</private> c',
    operator: 'strictEqual',
    diff: 'simple'
  }
 ELIFECYCLE  Test failed. See above for more details.
exit=1
```

### Reverted-state green runs, verbatim (task 1.5)

Command: `node --test src/redaction.test.ts`

```text
✔ redactPrivateTags replaces multiple private blocks (0.74653ms)
✔ redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone (0.093389ms)
✔ redactUrlPath redacts a percent-encoded private query value and preserves URL shape (0.18028ms)
✔ redactUrlPath redacts a private block in a path segment (0.099854ms)
✔ redactValue redacts nested strings and passes non-string primitives through (0.539649ms)
✔ redactText redacts then trims surrounding whitespace (0.080144ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 70.783776
exit=0
```

Command: `pnpm test`

```text

> dsh-gentle-engram@0.2.0 test /home/fy/Projects/code/dsh-gentle-engram
> node --test

✔ redactPrivateTags replaces multiple private blocks (0.754703ms)
✔ redactPrivateTags is case-insensitive, spans lines, and leaves untagged text alone (0.087277ms)
✔ redactUrlPath redacts a percent-encoded private query value and preserves URL shape (0.175128ms)
✔ redactUrlPath redacts a private block in a path segment (0.099044ms)
✔ redactValue redacts nested strings and passes non-string primitives through (0.518079ms)
✔ redactText redacts then trims surrounding whitespace (0.079924ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 75.602831
exit=0
```

The inverted fragment is absent from the final tree (`grep` exit 1) and the file was green
before it was staged, so the inverted state was never committed.

## Typecheck, build, and `dist/` (tasks 1.7, 1.8)

Typecheck — Command: `pnpm run typecheck`

```text

> dsh-gentle-engram@0.2.0 typecheck /home/fy/Projects/code/dsh-gentle-engram
> tsc -p tsconfig.json

exit=0
```

Exit 0. `git status --short tsconfig.json tsdown.config.ts` and `git diff tsconfig.json
tsdown.config.ts` were both empty — neither file was touched by this change.

Build — Command: `pnpm run build`

```text

> dsh-gentle-engram@0.2.0 build /home/fy/Projects/code/dsh-gentle-engram
> tsdown

[34mℹ[39m tsdown [2mv0.15.12[22m powered by rolldown [2mv1.0.0-beta.45[22m
[34mℹ[39m Using tsdown config: [4m/home/fy/Projects/code/dsh-gentle-engram/tsdown.config.ts[24m
[34mℹ[39m entry: [34msrc/index.ts[39m
[34mℹ[39m target: [34mnode22.18.0[39m
[34mℹ[39m tsconfig: [34mtsconfig.json[39m
[34mℹ[39m Build start
[34mℹ[39m [2mdist/[22m[1mindex.js[22m    [2m63.55 kB[22m [2m│ gzip: 18.76 kB[22m
[34mℹ[39m [2mdist/[22m[32m[1mindex.d.ts[22m[39m  [2m 1.59 kB[22m [2m│ gzip:  0.66 kB[22m
[34mℹ[39m 2 files, total: 65.13 kB
[32m✔[39m Build complete in [32m509ms[39m
exit=0
```

Exit 0. `ls -1 dist/` output:

```text
index.d.ts
index.js
```

`git status --short dist/` and `git diff dist/` were empty — build output byte-identical to
the committed `dist/`. `find dist -name '*test*'` → 0 matches.

## TDD Cycle Evidence

No RED/GREEN cycle — bootstrap exception, see below.

This change adds no production code (script + test + CI step + docs + config only), and its
strict-TDD flip is deliberately the last work unit, so no STRICT TDD MODE was injected while
this apply ran. The substitute gate evidence for this change is the negative control above
(one assertion inverted, non-zero exit observed in both focused and canonical runs) plus the
green `pnpm test` runs.

## Bootstrap exception (strict TDD)

- Ordering: runner script + pilot test landed in work-unit commit 1; `strict_tdd` flipped in
  work-unit commit 3 (last). Neither commit SHA can be listed inside itself; the three SHAs are
  recorded in the final apply/delivery report and re-derivable read-only via `git log`.
- Why: a config-first flip would make this change unsatisfiable under its own gate —
  no production code exists to make RED, and a missing script is a config error, not a failing test.
- Substitute gate evidence for this change: the negative control above (one inverted
  assertion, non-zero observed), plus green `pnpm test`.
- First genuine RED/GREEN cycle: the first module-suite follow-up change.

## Workload / PR boundary

Single PR containing three work-unit commits, per the tasks' Review Workload Forecast
(risk Low, chained PRs No, no `size:exception` needed). Work unit 1 is one commit; work units
2 and 3 follow in order, with the strict-TDD flip last.

## Remaining tasks

- [ ] 2.1 CI `Test` step between `Typecheck` and `Build`
- [ ] 2.2 `CONTRIBUTING.md` validation + convention line
- [ ] 2.3 append work-unit-2 evidence here
- [ ] 2.4 commit work unit 2
- [ ] 3.1 `openspec/config.yaml` strict-TDD target state
- [ ] 3.2 `openspec/config.yaml` context refresh
- [ ] 3.3 append work-unit-3 evidence here
- [ ] 3.4 commit work unit 3 (last)
- [ ] 3.5 post-commit read-only end-state verification (reported, not appended)
- [ ] 4.1 deferred: CI rung-0 evidence requires the branch to be pushed (human decision); no push was performed. When pushed, record workflow run URL/id, commit SHA, `Test` step conclusion, and a log excerpt naming `src/redaction.test.ts` with pass counts in the change report and PR body; if the step fails on Node 22, walk the design's contingency ladder in order (rung 1 explicit-path script pre-authorized, spec amended in the same change and noted here; rung 2 CI Node bump pauses for explicit user consent under ask-on-risk; otherwise stop and report blocked). `engines.node: ">=22.18"` unchanged at every rung.
