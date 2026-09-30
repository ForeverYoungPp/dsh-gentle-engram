# Archive Report — adopt-cordis-plugin-config

Status: **archived (PASS)**
Change: `adopt-cordis-plugin-config`
Store: openspec (file-backed)
Archive date: 2026-10-01 (UTC)
Archived path: `openspec/changes/archive/2026-10-01-adopt-cordis-plugin-config/`
Canonical spec composed: `openspec/specs/config/spec.md` (new domain — full-spec copy)

## Structured status consumed

Native `gentle-ai.sdd-status` v2 (read-only projection, consumed as authority — not recomputed from artifacts):

- `changeName: adopt-cordis-plugin-config`, `artifactStore: openspec`
- `applyState: all_done`; `taskProgress: 5/5 complete, 0 pending, allComplete: true`
- `dependencies.archive: ready`; `nextRecommended: archive`; `blockedReasons: []`
- `artifactPaths.verifyReport: []` (no verification report exists; verification is optional)
- `relationships.sameDomainActiveChanges: []`; `dependsOn / supersedes / amends / conflictsWith`: all empty
- `actionContext.mode: repo-local`; `workspaceRoot` / `allowedEditRoots`:
  `/home/fy/Projects/code/dsh-gentle-engram`. All archive writes, composition, and the move
  stayed inside the authoritative workspace and allowed edit roots.

## Artifacts read

- `openspec/changes/adopt-cordis-plugin-config/proposal.md`
- `openspec/changes/adopt-cordis-plugin-config/specs/config/spec.md` (the spec composed)
- `openspec/changes/adopt-cordis-plugin-config/design.md`
- `openspec/changes/adopt-cordis-plugin-config/tasks.md` (re-read immediately before composition)
- `openspec/changes/adopt-cordis-plugin-config/apply-progress.md`
- `openspec/config.yaml`
- `openspec/specs/` (only `testing/spec.md` existed; no prior `config` canonical spec) and
  `openspec/changes/archive/` (only `2026-09-21-add-test-harness/` existed)
- Git tree state (`git status`, `git diff --stat`, `git diff -- cordis.patch.yml`) and built
  `dist/index.js` / `dist/index.d.ts`

Absent as expected: `verify-report.md` (verification was not run — optional),
`sync-report.md` (no separate sync phase was run; archive owns composition).

## Final task completion gate

- The persisted `openspec/changes/adopt-cordis-plugin-config/tasks.md` was re-read immediately
  before any composition or move. All five task lines read `- [x]`.
- `grep '^\s*- \[ \]' openspec/changes/adopt-cordis-plugin-config/tasks.md` returned **no matches**.
- No unchecked implementation task lines remain. No archive-time stale-checkbox repair was
  performed or needed, and no reconciliation instruction or proof was required.
- Historical `tasks.md` bytes were preserved by archive (unchanged; see hash manifest).

## Verification findings

- **`sdd-verify` was NOT run.** Verification is optional under native status and was not invoked.
  This report records "not run" — it makes no pass claim and invents no findings.
- The parent ran the acceptance gates directly and they are green:
  `pnpm test` 122 passing / 0 failing (101 baseline + 21 new), `pnpm run typecheck` exit 0,
  `pnpm run build` exit 0.
- Consequently there are no `FAIL`, `BLOCKED`, or `CRITICAL` findings and no verification
  blockers; the missing verification report is not an archive admission gate.

## Composition (new domain — no delta merge)

- Before composition, `openspec/specs/config/` did not exist and no canonical `config` spec
  existed. The `config` capability is introduced by this change.
- Mode: **new-domain full-spec copy**. The change spec is a full domain spec under
  `## Requirements` with no `## ADDED` / `## MODIFIED` / `## REMOVED` / `## RENAMED` operation
  sections; by mode, none are expected and none were emitted.
- `openspec/specs/config/spec.md` is a byte-identical copy of
  `openspec/changes/adopt-cordis-plugin-config/specs/config/spec.md`
  (sha256 `5477ea05b8646aee103cd83e06d413fefccb9e2029c7c02649ac94af873ea89c`; `cmp` clean).
- Requirements carried — all 11, new additions:
  1. Exported `Config` Schema on the Standard Cordis Plugin Surface
  2. Fail-Closed Validation of Invalid Config Values
  3. Field Defaults and Bounds Preserved Exactly
  4. Non-Integer Numbers Are Rejected
  5. Unknown Config Keys Must Error
  6. Environment Variables Keep Precedence Over yml
  7. Malformed Environment Values Fail Closed
  8. `url` Empty-String Sentinel Round-Trip
  9. Removal of Silent-Fallback Machinery
  10. Colocated Config Test Coverage
  11. Change Scope Containment
- Scenarios carried: **17 of 17** (the design's "18 scenarios" forecast was an estimate; the
  authored spec contains 17 `#### Scenario:` blocks, counted at archive time).
- MODIFIED: none. REMOVED: none. No destructive merge occurred and no destructive approval was
  required, granted, or exercised. Since the domain is new and every requirement is an addition,
  the Resume-prior-composition already-applied / pending / unresolved classification is trivial:
  11 ADDED operations, all pending, all now applied by the copy above.
- Same-domain collision: none. Native `sameDomainActiveChanges` is empty, and a filesystem scan of
  `openspec/changes/*/specs/config/spec.md` found no other active change touching the `config`
  domain.
- Native validation:
  - Canonical file: `openspec validate config --type spec --strict` → **valid** (info-only notes
    that requirement text is long, inherited verbatim from the change spec).
  - Change-level `openspec validate adopt-cordis-plugin-config --type change` reports the spec as
    not using delta sections (11 "not a delta section" warnings + "No delta sections found"), which
    is the expected structural consequence of the full-spec new-domain form directed for this
    archive. The change spec bytes were not rewritten to suppress that finding.
  - Unrelated CLI observation: the OpenSpec CLI prints `Rules for '<artifact>' must be an array of
    strings` because `openspec/config.yaml` uses gentle-ai's object-shaped `rules.*` format. That is
    a config-format mismatch independent of this change and did not affect composition.

## Spec requirement 11 narrowing (recorded final-state decision)

Requirement 11's bare-import acceptance criterion was **narrowed after apply by explicit user
decision**: the runtime bundle `dist/index.js` only. `dist/index.d.ts` is an explicitly excepted,
recorded deviation. Exporting `Config` on the public surface necessarily references the schema's
type while `@deepseek-ai/schemastery` is a devDependency, and `@standard-schema/spec` (cordis's own
dependency, not this package's) does not resolve in this repository either. This is acceptable
because the harness loads the plugin as a runtime bundle, no consumer resolves these types at load
time, and this repository itself typechecks with `skipLibCheck: true`. Archive read the current
`specs/config/spec.md`, which already carries this narrowed criterion and the recorded deviation
verbatim; the canonical copy preserves it. Observed at archive time: `dist/index.js` contains no
bare `import` of `@deepseek-ai/schemastery` (only an inlined-region comment string), and
`dist/index.d.ts:2` carries the accepted type-only `import Schema from "@deepseek-ai/schemastery"`.

## Scope containment (spec requirement 11 — observed at close)

| Check | Observed |
| --- | --- |
| `git diff -- cordis.patch.yml` | **empty** — byte-identical |
| `package.json` dependency sections | unchanged by apply; the parent-owned `@deepseek-ai/schemastery` devDependency addition pre-existed apply and is not this change's authored diff |
| `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/**`, `tsconfig.json`, `tsdown.config.ts`, workflows | untouched |
| Publish / release / tag / version bump | none |
| Realized authored size | **390 changed lines** against the 400-line budget (`src/config.ts` +86/−59, `src/index.ts` +8/−3, six existing test call sites +10/−10 total, new `src/config.test.ts` 214 lines) |
| Delivery decision | within budget — `ask-on-risk` raised no delivery gate; single PR, no chain |

Nothing was published, released, tagged, or version-bumped. `cordis.patch.yml` is byte-identical.
A previously staged npm publication of version 0.7.0 (stage-id `4189b091-0c2a-40c4-8762-2daeabd7eff1`,
commit `4838075`) is on hold for the same human in-DSH test reason and is **not** part of this
change. The user will load the built plugin inside DSH and test it manually before any publish;
that publish remains a separate later human decision.

## Version control

The work was uncommitted at archive time. The parent owns version control; archive did **not**
commit, tag, stash, checkout, or rebase anything. Branch `fix/dsh-0.2.0-lifecycle-event` carries two
existing local commits (`4838075`, `15703ac`) treated as unrelated prior work, not part of this
change. Archive only added `openspec/specs/config/spec.md`, wrote this report, and renamed the
change folder.

## Move and byte preservation

- Destination `openspec/changes/archive/2026-10-01-adopt-cordis-plugin-config/` did not exist
  before the move; there was no overwrite.
- The change folder was moved intact (single-directory rename within `openspec/changes/`).
  Pre-move sha256 manifest, re-verified after the move:

| File (relative to the change folder) | sha256 |
| --- | --- |
| `proposal.md` | `4e50e2f8855e196624402c062383485c9d377c53a1a5d444d440e1a36ce98c9a` |
| `design.md` | `cace4f85fc49692c64a6c7df972e92659c2b8843ce607aeedfb851c4ad96441a` |
| `tasks.md` | `04cd6afce7b17849f6861acc2aeffa66d3a2f4a0f84dbe67dde96d66db2ceba7` |
| `apply-progress.md` | `7b61ca711de7503efec925cd08245b7d884c88725e4fe4fd61991dd2e9b57c4a` |
| `specs/config/spec.md` | `5477ea05b8646aee103cd83e06d413fefccb9e2029c7c02649ac94af873ea89c` |

- Post-move re-hash of all five files matched the manifest above; `archive-report.md` (this file) is
  the only added file in the archived folder.
- No archived change was deleted or silently modified.

## Memory observation IDs

Not applicable — artifact store is `openspec` only; no Engram observation was written for this
phase.
