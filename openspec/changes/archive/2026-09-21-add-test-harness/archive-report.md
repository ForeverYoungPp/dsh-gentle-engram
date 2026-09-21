# Archive Report — add-test-harness

Status: **archived (PASS)**
Change: `add-test-harness`
Store: openspec (file-backed)
Archive date: 2026-09-21 (UTC)
Archived path: `openspec/changes/archive/2026-09-21-add-test-harness/`
Canonical spec composed: `openspec/specs/testing/spec.md` (new domain — full-spec copy)

## Structured status consumed

Native `gentle-ai.sdd-status` v2 (read-only projection, consumed as authority — not recomputed from artifacts):

- `changeName: add-test-harness`, `artifactStore: openspec`
- `applyState: all_done`; `taskProgress: 20/20 complete, 0 pending, allComplete: true`
- `dependencies.archive: ready`; `nextRecommended: archive`; `blockedReasons: []`
- `artifactPaths.verifyReport: []` (no verification report exists)
- `relationships.sameDomainActiveChanges: []`
- `actionContext.mode: repo-local`; `workspaceRoot` / `allowedEditRoots`:
  `/home/fy/Projects/code/dsh-gentle-engram`. All archive writes, composition, and the move
  stayed inside the authoritative workspace and allowed edit roots.

## Artifacts read

- `openspec/changes/add-test-harness/proposal.md`
- `openspec/changes/add-test-harness/specs/testing/spec.md` (the spec composed)
- `openspec/changes/add-test-harness/design.md`
- `openspec/changes/add-test-harness/tasks.md`
- `openspec/changes/add-test-harness/apply-progress.md`
- `openspec/changes/add-test-harness/exploration.md`
- `openspec/config.yaml`
- Git history and tree state (`git log`, `git show d62c5ed`, `git status`)
- `openspec/specs/` (empty — no prior `testing` canonical spec) and
  `openspec/changes/archive/` (empty — destination free)

Absent as expected: `verify-report.md` (verification was not run — optional), `sync-report.md`
(no separate sync phase was run; archive owns composition).

## Task state at close (actual, not optimistic)

- **20 of 20 tasks completed.** Every task line in the persisted `tasks.md` is `- [x]`;
  `grep '^\s*- \[ \]' openspec/changes/add-test-harness/tasks.md` returned no matches at archive time.
- No archive-time stale-checkbox repair was performed or needed. No unchecked implementation task
  lines remain, so no reconciliation proof was required.
- Four commits on `main` at close:
  1. `ec11052` — `test: add Node stdlib test harness with pilot redaction test`
  2. `e688f69` — `ci: gate checks on pnpm test and document the test contract`
  3. `6520200` — `chore(openspec): enable strict TDD now that the harness is green` (strict-TDD flip, last work-unit commit)
  4. `d62c5ed` — `docs(openspec): record rung-0 CI evidence and close task 4.1` (evidence-only)
- `d62c5ed` is an authorized, disclosed deviation from the design's three-commit plan:
  task 4.1's checkbox could only be closed after the push by editing a tracked file after the
  strict-TDD commit, and native `allComplete` derives from checkbox lines. `git show d62c5ed`
  shows only `apply-progress.md` and `tasks.md`. Full disclosure is recorded in
  `apply-progress.md` ("Two deviations from the task as written, both human-authorized"). The
  historical task and report bytes were preserved by archive; only `archive-report.md` was added.

## Verification findings

- **`sdd-verify` was NOT run.** Verification is optional under native status and was not invoked.
  This report records "not run" — it makes no pass claim and invents no findings.
- Consequently there are no `FAIL`, `BLOCKED`, or `CRITICAL` findings and no verification blockers;
  the missing verification report is not an archive admission gate.

## Composition (new domain — no delta merge)

- Before composition, `openspec/specs/testing/` did not exist and no canonical `testing` spec existed.
- Mode: **new-domain full-spec copy**. The change spec is a full domain spec under
  `## Requirements` with no `## ADDED` / `## MODIFIED` / `## REMOVED` / `## RENAMED` operation
  sections; by mode, none are expected and none were emitted.
- `openspec/specs/testing/spec.md` is a byte-identical copy of
  `openspec/changes/add-test-harness/specs/testing/spec.md`
  (sha256 `a45310073a3cc9cd0f77d10519770013edecc3b42f5691df0187c1d1f3653dfd`; `cmp` clean).
- Requirements carried — all 8, new additions:
  1. Zero-Dependency Test Runner
  2. Colocated `src/**/*.test.ts` Test Convention
  3. Declared Node Runtime Floor
  4. CI Test Gate
  5. Strict-TDD Configuration and Bootstrap Ordering
  6. Pilot Redaction Coverage
  7. Gate Negative Control
  8. Contributor Test Contract
- Scenarios carried: 14 of 14.
- MODIFIED: none. REMOVED: none. No destructive merge occurred and no destructive approval was
  required, granted, or exercised.
- Same-domain collision: none. Native `sameDomainActiveChanges` is empty, and a filesystem scan of
  `openspec/changes/*/specs/testing/` found no other active change touching the `testing` domain.
- Native validation:
  - Canonical file: `openspec validate testing --type spec --strict` → **valid** (info-only notes
    about long requirement text, inherited verbatim from the change spec).
  - Change-level `openspec validate add-test-harness --type change` reports the spec as not using
    delta sections (8 warnings + "No delta sections found"), which is the expected structural
    consequence of the full-spec new-domain form directed for this archive. The change spec bytes
    were not rewritten to suppress that finding.
  - Unrelated CLI observation: the OpenSpec CLI prints `Rules for '<artifact>' must be an array of
    strings` because `openspec/config.yaml` uses gentle-ai's object-shaped `rules.*` format. That is
    a config-format mismatch independent of this change and did not affect composition.

## CI evidence (contingency ladder rung 0 discharged)

| Field | Observed |
| --- | --- |
| Workflow run | `CI`, id `35620396901`, event `push`, branch `main`, commit `6520200`, conclusion **success** |
| URL | `https://github.com/ForeverYoungPp/dsh-gentle-engram/actions/runs/35620396901` |
| Node version | `22` (from the `Set up Node.js` step log) |
| `checks` steps | 7 `Typecheck` success → 8 **`Test` success** → 9 `Build` success |
| `Test` step log | `> node --test` → `TAP version 13` → `# tests 6` / `# suites 0` / `# pass 6` / `# fail 0` |

- **Recorded wording deviation:** the CI run log does **not** contain the string
  `src/redaction.test.ts`; Node 22's TAP reporter omits the file path on an all-green single-file
  run. Discovery is established by the six recorded test names plus the pass counts, which can only
  come from Node 22 discovering and executing that colocated `.ts` file (the repository has no other
  test file). The design's expectation that the log would name the file is superseded.
- Ladder outcome: **rung 0 discharged**. No rung-1 explicit-path amendment and no rung-2 CI Node
  bump occurred or were needed; `engines.node` remains `>=22.18`; no `continue-on-error`, `|| true`,
  `Test`-step removal, or `skip` was introduced at any rung.

## Strict TDD and bootstrap exception

- `openspec/config.yaml` is at its target end state: `strict_tdd: true`,
  `rules.apply.test_command: "pnpm test"`, `rules.verify.test_command: "pnpm test"`,
  `testing.runner` `{ command: "pnpm test", framework: "node:test" }`, `testing.layers.unit:
  "node:test"`, and one `testing.commands.unit` entry (`.`, `pnpm test`, `node:test`); coverage,
  lint, format, and e2e fields remain empty.
- The bootstrap ordering constraint held: the strict-TDD flip (`6520200`) is the first commit
  setting `strict_tdd: true` and its tree already contains `"test": "node --test"` and
  `src/redaction.test.ts`.
- The bootstrap exception (no RED/GREEN cycle in this change, because it establishes the harness
  itself; first genuine RED/GREEN cycle belongs to the first module-suite change) is recorded in
  `apply-progress.md` under `## Bootstrap exception (strict TDD)`.
- The harness's ability to fail is proven by the recorded negative control: with one assertion
  inverted (`redactPrivateTags` multiple-blocks expected literal), both the focused and canonical
  runs exited non-zero with the failing assertion pasted; reverting restored exit 0. The inverted
  state was never committed and is absent from the final tree. Full transcript is in
  `apply-progress.md` under `## Negative control (proves the harness can fail)`.

## Known non-blocking observation (not this change)

The same push triggered `Release Please`, which failed with
`GitHub Actions is not permitted to create or approve pull requests` (a repository setting) and
logged an unexpected `0.2.0 → 1.0.0` bump, leaving the branch
`release-please--branches--main--components--dsh-gentle-engram` behind. This is unrelated to
`add-test-harness` and does not affect its acceptance criteria. The stale remote branch
`feat/add-test-harness` is likewise left for the human to decide; archive did not touch remote
branches and did not push.

## Move and byte preservation

- Destination `openspec/changes/archive/2026-09-21-add-test-harness/` did not exist before the
  move; there was no overwrite.
- The change folder was moved intact (single-directory rename within `openspec/changes/`).
  Pre-move sha256 manifest, re-verified after the move:

| File (relative to the change folder) | sha256 |
| --- | --- |
| `proposal.md` | `d5544661a9793e1c08f6665b64edc4bac6cba569e2aa422dbb87020817d00e70` |
| `design.md` | `26154a9b3061d6bc27c93e36e3fa06e6ff6ab252415ec5bc4a782425e944e13e` |
| `exploration.md` | `aceb50db14bfecf53c8b6fb68b35cfe6ebb6154c847c9c3964c01ddef380d3e5` |
| `tasks.md` | `e5f32b309b92b4181bc45bdc65ea76f3e2610ba1d60f73060f4718e143e77f1c` |
| `apply-progress.md` | `03034b500e869625fdf0a6ea080f94ca0558c75091aa85a2693417355bd4eaf5` |
| `specs/testing/spec.md` | `a45310073a3cc9cd0f77d10519770013edecc3b42f5691df0187c1d1f3653dfd` |

- Post-move re-hash of all six files matched the manifest above; `archive-report.md` (this file) is
  the only added file in the archived folder.
- Composition and the move are committed as one work unit:
  `docs(openspec): archive add-test-harness and compose canonical testing spec`, staged with
  `git add -A -- openspec/specs openspec/changes`. `.pi/` remains untracked and uncommitted.
- Post-commit end state: `git status --short` prints exactly `?? .pi/`.

## Memory observation IDs

Not applicable — artifact store is `openspec` only; no Engram observation was written for this
phase.
