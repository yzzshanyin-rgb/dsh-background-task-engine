# Test Report

Verification record for `dsh-background-task-engine` 1.0.0 against PRD chapter 14.

## How to reproduce

```sh
npm install
npm run build          # tsc -> dist/
npm test               # vitest run
```

## Summary

| Suite | File | Tests | Result |
|---|---|---|---|
| Domain | `tests/domain/state.test.ts` | 18 | PASS |
| Storage | `tests/storage/repository.test.ts` | 17 | PASS |
| Rendering | `tests/tools/render.test.ts` | 13 | PASS |
| Integration | `tests/integration/tools.test.ts` | 33 | PASS |
| **Total** | 4 files | **81** | **all passing** |

```console
$ npx vitest run
 ✓ tests/domain/state.test.ts (18 tests)
 ✓ tests/storage/repository.test.ts (17 tests)
 ✓ tests/tools/render.test.ts (13 tests)
 ✓ tests/integration/tools.test.ts (33 tests)

 Test Files  4 passed (4)
      Tests  81 passed (81)
```

The integration suite drives the real plugin entry point (`apply()` →
`ctx.tools.register`) through a fake StorageDomain whose semantics mirror the
documented host contract: synchronous reads, a serialized per-key write chain,
zod validation at the boundary, and `missing-key` on `update`. The fake context
even throws on un-injected service property access, like Cordis does.

## Host-side verification (not part of `npm test`)

Two scripts boot the **real** DSH packages out of the installed `app.asar`:

| Check | Result |
|---|---|
| 12 tools registered and visible in `tools.schemas()` | 12 / 12 |
| All schemas accepted by the host's `assertSupportedJsonSchema` | 12 / 12 |
| `task_create` → `task_run` → 2 × `task_step_report` → `task_run_finish` | succeeded, 100 %, 2/2 required |
| `task_run_history` after the loop | 1 run, `succeeded` |
| Duplicate schedule delivery (`scheduleId` + `occurrenceKey`) | same `runId`, `deduplicated: true` |
| Persisted JSON document | `dsh_background_task_engine.json`, unit v1, 4 tables |
| Restart over the same file | task + steps intact, stale run → `interrupted` |
| Resume after restart | new `runId`, `resumesRunId` set, 1 carried / 1 pending |

Details and console output: `docs/API-COMPATIBILITY-AUDIT.md` §6.

## Requirement coverage (PRD 14)

| PRD | Requirement | Covered by |
|---|---|---|
| 14.1 | unique `taskId`; title/steps/>10 rejected; revision increments and stale revision rejected; archive keeps history; snapshot frozen | `integration` → *task templates (PRD 14.1)* |
| 14.2 | independent TaskRun; strict step order; unknown `stepId` and skips rejected; idempotency key; `succeeded` needs all required steps; failure keeps step id/error/time | `integration` → *manual execution (PRD 14.2)* |
| 14.3 | link host schedule; failed rule update not reported as success; pause/resume/delete honour host result; delivery identifies task + occurrence; duplicate delivery does not restart; delivery ≠ success | `integration` → *schedule linkage (PRD 14.3)* |
| 14.4 | records survive restart; stale run → `interrupted`; resume creates new run with `resumesRunId`; starts at first unfinished step; no automatic replay; old run unchanged | `integration` + `storage` + real-host restart run |
| 14.5 | cross-Session reads/writes denied; active-run cap; illegal transitions rejected; malicious text inert; no credential/path leakage | `integration` → *isolation, concurrency and safety*; `domain` → *error contract* |
| 14.6 | installs in the local profile; tools callable; missing StorageDomain errors loudly; Schedule optional; uninstall keeps data | `plugin_manager install_bundle` → `application: applied`; `integration` → *tool registration and startup* |
| 14.7 | definition of done (installable, CRUD, 1–10 steps, manual + schedule, run/step state, recovery, idempotency/concurrency/isolation, persistence + migration + prune, tests, docs) | this report + README + CHANGELOG |

## Bugs found and fixed during verification

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Install rejected: *"dsh.bundle.patch must be a file path or a list of file paths"* | manifest used the flat `dsh.bundle: "./cordis.patch.yml"` form | nested `dsh.bundle.patch` |
| 2 | Install reported *"cannot get property \"schedule\" without inject"* | optional service read as a context property | `optionalService()` via `ctx.get`, absence = not mounted |
| 3 | Every tool returned `TASK_STORAGE_ERROR: invalid unit name 'dsh-background-task-engine'` **on the real host only** | host `UNIT_NAME_RE` forbids hyphens | unit renamed to `dsh_background_task_engine`, asserted in tests, re-checked at startup |
| 4 | A custom renderer hid the error text on failed calls | early `return` used the wrong check | single `isFailure()` guard used by every presenter |
| 5 | `renderRun` swapped `(args, value)` | argument order | corrected, plus a test that renders **every** tool with a failure envelope |
| 6 | Repeating a terminal `step_report` was silently treated as a no-op | blanket same-status short-circuit | only a repeated `started` is idempotent; terminal repeats are ordering errors |

Bugs 1–3 were only observable against the real host, which is why
`docs/API-COMPATIBILITY-AUDIT.md` records the real-stack runs separately from the
unit suite.

## Post-publish verification (GitHub artifact)

The committed `main` was cloned fresh and treated as an independent artifact:

| Check | Result |
|---|---|
| `git clone` from `github.com:yzzshanyin-rgb/dsh-background-task-engine` | ok, commit `a01bdd6` |
| Fresh `npm install && npm run build` | BUILD OK |
| Rebuilt `dist/` vs committed `dist/` | identical (`git status` clean) |
| `npm test` in the clone | **81 / 81 passing** |
| `npm pack` tarball | 58 files, 81 KB |
| Tarball contents | `dist/index.js`, `locale/{en,zh}.json`, `icon.svg`, `docs/DETAIL{,.zh}.md`, `docs/preview.svg`, `cordis.patch.yml` all present |
| Tarball installed into a clean project | 12/12 tools register; `Config()` returns the documented defaults |
| Clone installed into the real desktop profile | `application: applied`, no warnings |

Two packaging details were confirmed while doing this: `@deepseek-ai/schemastery`
must stay a regular dependency (every installed community plugin that defines a
`Config` declares it the same way), and the shipped `dist/` is byte-identical to a
fresh build, so the published artifact cannot drift from source.

## Test inventory

Every assertion from the last full run is listed below.


### tests/domain/state.test.ts (18)

- `PASS` TaskRun state machine accepts the documented transitions
- `PASS` TaskRun state machine refuses to go back from a non-running state to running
- `PASS` TaskRun state machine treats terminal states as final
- `PASS` TaskRun state machine rejects re-reporting the same step status
- `PASS` progress and ordering computes floor(completed required / required total * 100)
- `PASS` progress and ordering never counts optional or non-completed steps as progress
- `PASS` progress and ordering finds the first unfinished step in order
- `PASS` progress and ordering blocks succeeded while a required step is unfinished
- `PASS` progress and ordering refuses to start a later step before its predecessors
- `PASS` error contract sanitises paths, stacks and credentials
- `PASS` error contract maps unknown failures to TASK_INTERNAL_ERROR and missing keys to TASK_NOT_FOUND
- `PASS` configuration validation fills documented defaults
- `PASS` configuration validation rejects out-of-range values instead of clamping
- `PASS` trigger payload parsing extracts task, schedule and occurrence from a delivery message
- `PASS` trigger payload parsing returns an empty envelope for unrelated text
- `PASS` pagination and text limits round-trips cursors and keysets by (timestamp, id)
- `PASS` pagination and text limits treats an invalid cursor as the first page and compares ties by id
- `PASS` pagination and text limits truncates summaries at the configured bound and strips control characters

### tests/storage/repository.test.ts (17)

- `PASS` domain declaration uses host-legal unit and table names
- `PASS` domain declaration declares three model tables plus the metadata table
- `PASS` domain declaration rejects records that do not match the declared schema
- `PASS` migrations records an applied migration in the ledger exactly once
- `PASS` migrations stops writing when a migration fails and leaves no marker
- `PASS` migrations refuses data written by a newer schema version
- `PASS` migrations ships no migration for v1 (the baseline shape needs none)
- `PASS` integrity verification reports a clean domain
- `PASS` integrity verification detects runs that reference a missing task
- `PASS` repository write semantics serialises concurrent mutations so the revision advances exactly once per call
- `PASS` repository write semantics writes steps before the run so a crash cannot leave progress without a run
- `PASS` repository write semantics deletes a run together with its step rows
- `PASS` retention pruning removes only old terminal runs and never an active one
- `PASS` startup recovery interrupts a stale run and its running step without creating a new run
- `PASS` startup recovery leaves a freshly updated run alone
- `PASS` facility wiring opens the declared domain once and reads back the same handle
- `PASS` facility wiring schedule adapter reports unavailability without a host service

### tests/integration/tools.test.ts (33)

- `PASS` tool registration and startup registers all 12 task_* tools
- `PASS` tool registration and startup publishes a JSON Schema the host subset accepts for every tool
- `PASS` tool registration and startup refuses to start without a StorageDomain instead of degrading to memory
- `PASS` tool registration and startup reports a storage open failure through TASK_STORAGE_ERROR
- `PASS` task templates (PRD 14.1) creates a task with a unique id, revision 1 and ordered steps
- `PASS` task templates (PRD 14.1) rejects a missing title, empty steps and more than 10 steps
- `PASS` task templates (PRD 14.1) increments revision and rejects a stale expectedRevision
- `PASS` task templates (PRD 14.1) keeps run history after archiving and blocks further edits
- `PASS` task templates (PRD 14.1) freezes the step template at run start
- `PASS` task templates (PRD 14.1) lists, filters and paginates tasks per session
- `PASS` task templates (PRD 14.1) copies an existing template
- `PASS` manual execution (PRD 14.2) creates an independent TaskRun with a snapshot and pending steps
- `PASS` manual execution (PRD 14.2) executes steps in order and reports persisted progress
- `PASS` manual execution (PRD 14.2) rejects unknown step ids and duplicate reports
- `PASS` manual execution (PRD 14.2) refuses succeeded until every required step is completed
- `PASS` manual execution (PRD 14.2) records the failed step id, error summary and timestamp
- `PASS` manual execution (PRD 14.2) is idempotent on manualRunId
- `PASS` manual execution (PRD 14.2) supports the queued → running two-phase start
- `PASS` schedule linkage (PRD 14.3) creates and links a native schedule, then pauses and resumes it
- `PASS` schedule linkage (PRD 14.3) does not report success when the host rule update fails
- `PASS` schedule linkage (PRD 14.3) unlinks the rule on delete and on archive
- `PASS` schedule linkage (PRD 14.3) keeps manual execution working when Schedule is unavailable
- `PASS` schedule linkage (PRD 14.3) identifies task and occurrence from a scheduled delivery and dedupes repeats
- `PASS` schedule linkage (PRD 14.3) rejects an unidentifiable trigger payload
- `PASS` recovery semantics (PRD 14.4) marks a stale running run as interrupted on the next startup
- `PASS` recovery semantics (PRD 14.4) resumes from the first unfinished step without replaying completed ones
- `PASS` recovery semantics (PRD 14.4) resumes a blocked run without confirmation because no step failed
- `PASS` recovery semantics (PRD 14.4) refuses to resume a run that may still be executing
- `PASS` isolation, concurrency and safety (PRD 14.5) hides another session’s tasks behind TASK_NOT_FOUND
- `PASS` isolation, concurrency and safety (PRD 14.5) enforces the per-owner active run limit
- `PASS` isolation, concurrency and safety (PRD 14.5) rejects illegal transitions such as reporting on a paused task or finishing twice
- `PASS` isolation, concurrency and safety (PRD 14.5) keeps malicious template text inert
- `PASS` isolation, concurrency and safety (PRD 14.5) never echoes credentials or host paths in error results

### tests/tools/render.test.ts (13)

- `PASS` uniform envelope renders failures as a single actionable line
- `PASS` uniform envelope declares success and error on every output schema
- `PASS` timing translation passes through at / every / rrule / cron
- `PASS` timing translation expresses daily and weekly wall-clock schedules as an RRULE
- `PASS` timing translation rejects invalid timing input instead of silently accepting it
- `PASS` timing translation describes every timing shape for display
- `PASS` host schedule prompt carries the task id so a delivery can be mapped back to a task
- `PASS` tool rendering (what the model sees) renders a created task with its id, steps and revision
- `PASS` tool rendering (what the model sees) renders run progress with per-step marks and the next step
- `PASS` tool rendering (what the model sees) renders a failure with the failing step and the recovery hint
- `PASS` tool rendering (what the model sees) renders every tool without throwing on a failure envelope
- `PASS` schedule adapter failure mapping maps host rejections to TASK_SCHEDULE_FAILED with a sanitised message
- `PASS` schedule adapter failure mapping treats a missing host entry as already gone rather than a hard failure