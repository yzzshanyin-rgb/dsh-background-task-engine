# dsh-background-task-engine

Durable background task engine for **DeepSeek Harness (DSH)**: reusable task
templates, ordered linear steps, one persisted run ledger, progress and history
queries, explicit failure/interruption recovery, and optional linkage to native
DSH Schedule.

It does not reimplement a scheduler, an agent loop, a job registry or a storage
backend — it composes the Host's own `ctx.schedule`, `ctx.storageDomain` and
`ctx.tools`.

- [Install](#install)
- [Tools](#tools)
- [Execution protocol](#execution-protocol)
- [Data model](#data-model)
- [Configuration](#configuration)
- [Errors](#errors)
- [Security](#security)
- [Upgrade](#upgrade)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install

Requirements: DSH **0.2.2-rc.3** or a compatible release with
`ctx.storageDomain` mounted (the stock base bundle does this with
`storage-domain backend: json`).

```sh
# from a local checkout
dsh plugin --profile <name> add /absolute/path/to/dsh-background-task-engine

# or from npm
dsh plugin --profile <name> add dsh-background-task-engine
```

Then restart the app. Confirm in **Plugins** that the row
`background-task-engine` is enabled; the row shows this bundle's title,
description and icon.

The bundle patch is intentionally empty apart from the plugin row, so installing
it does not change any other setting:

```yaml
- insert:
    - id: background-task-engine
      name: 'dsh-background-task-engine'
      config: { ... }
```

## Tools

Twelve model-facing tools, all returning
`{ success: true, ... }` or `{ success: false, error: { code, message, retryable, relatedRunId? } }`.

| Tool | Purpose | Key arguments |
|---|---|---|
| `task_create` | Create a template (1–10 steps) | `title`, `description?`, `steps[]`, `copyFromTaskId?` |
| `task_list` | List this Session's templates | `status?`, `query?`, `limit?`, `cursor?` |
| `task_get` | Read one template + recent runs | `taskId`, `includeRuns?` |
| `task_update` | Edit title/description/steps/status | `taskId`, `expectedRevision`, `changes` |
| `task_archive` | Soft-archive; history preserved | `taskId`, `expectedRevision` |
| `task_schedule` | Manage the native schedule link | `taskId`, `action`, `timing?`, `scheduleRule?` |
| `task_run` | Start a manual run now | `taskId`, `manualRunId?`, `defer?` |
| `task_run_begin` | Claim a run (task or queued run or delivery payload) | `taskId?`, `runId?`, `triggerPayload?`, `scheduleId?`, `occurrenceKey?`, `idempotencyKey?` |
| `task_step_report` | Report a step | `runId`, `stepId`, `action`, `summary?`, `error?` |
| `task_run_finish` | Submit the run result | `runId`, `status`, `summary?`, `error?` |
| `task_run_history` | Page run history | `taskId`, `status?`, `limit?`, `cursor?` |
| `task_resume` | Recover a failed/interrupted/blocked run | `runId`, `confirmation?` |

`task_schedule` actions: `create`, `update`, `pause`, `resume`, `delete`,
`run_now`, `status`. Timing input accepts `at`, `every`, `rrule`, `cron`,
`daily`, `weekly`; `daily`/`weekly` are translated to an equivalent `RRULE` so
the plugin depends on fewer host shapes. The plugin stores only `scheduleId`
plus a small reference — never a copy of cron state.

## Execution protocol

A run is executed **by the calling Agent in its own authorized context**. There
is no worker process, and a `followup` receipt is never treated as completion.

1. `task_run` or `task_run_begin` → `runId` + snapshot + step list.
2. For each step in `order`: `task_step_report(action:"started")`.
3. `task_step_report(action:"completed" | "failed" | "skipped")` with a real
   summary. `completed` requires the step's `completionCriteria` to be met.
4. Missing input, a pending approval, or an unmet external condition →
   `task_run_finish(status:"blocked", summary:"…")` naming what is awaited.
5. All required steps completed → `task_run_finish(status:"succeeded")`.
6. A failure → `task_step_report(action:"failed", error:{…})` **then**
   `task_run_finish(status:"failed")`.

Progress is always `floor(completed required steps / required steps × 100)` and is
recomputed from persisted step rows — never from caller claims.

### Scheduled runs

A `task_schedule` create stores a prompt carrying `task_id_json` on the host
schedule. When a delivery arrives:

```text
task_run_begin({ triggerPayload: "<the delivered message>" })
```

The tool extracts `task_id_json`, `schedule_id_json` and `occurrence_at`, then
uses `schedule:<scheduleId>:<occurrence>` as the idempotency key. A duplicated
delivery returns the existing run with `deduplicated: true` instead of starting a
second execution. **Delivery proves the message was enqueued — not that the run
finished.**

## Data model

StorageDomain unit `dsh_background_task_engine`, schema version `1`
(the underscore form is required: the host's unit-name rule is
`/^[a-z][a-z0-9_]*$/`).

| Table | Key | Contents |
|---|---|---|
| `tasks` | `taskId` | template, status, revision, owner Session, steps, schedule reference |
| `task_runs` | `runId` | status, trigger, snapshot, progress, times, summary/error, `resumesRunId` |
| `task_run_steps` | `runId/stepId` | per-run step status, attempt, times, summary/error |
| `meta` | `global` | `schemaVersion`, applied-migration ledger, recovery/prune timestamps |

Status machines:

```text
Task     active → paused → active          active/paused → archived (final)
TaskRun  queued → running → succeeded | failed | blocked | interrupted
         queued → skipped
         blocked → failed | interrupted   (never back to running)
```

`failed`, `succeeded`, `interrupted` and `skipped` are terminal. Recovery always
creates a **new** run with `resumesRunId`; completed steps are carried over, the
run continues at the first unfinished step, and a run whose failed step may have
had side effects requires an explicit `confirmation`.

Retention: terminal runs older than `historyRetentionDays` (default 90) are
pruned with their step rows at startup. Active runs, templates and audit events
are never pruned.

## Configuration

Exported as `Config` (Schemastery) and validated again at load; out-of-range
values fail the load rather than being clamped.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `maxTasksPerOwner` | 100 | 1–1000 | unarchived templates per Session |
| `maxStepsPerTask` | 10 | 1–10 | steps per template (V1.0 is linear) |
| `maxActiveRunsPerOwner` | 3 | 1–20 | concurrent queued/running runs per Session |
| `maxParallelRunsPerTask` | 1 | 1 | parallel runs of one task (fixed in V1.0) |
| `defaultTimeoutMinutes` | 60 | 1–1440 | timeout used for identification only |
| `staleRunAfterMinutes` | 30 | 1–1440 | age at which a startup scan marks a run `interrupted` |
| `historyRetentionDays` | 90 | 1–3650 | terminal run retention |
| `maxSummaryChars` | 2000 | 100–10000 | summary truncation bound |

## Errors

| Code | Meaning | Retryable |
|---|---|---|
| `TASK_NOT_FOUND` | task missing, or not owned by this Session | no |
| `TASK_ALREADY_RUNNING` | the task already has an active run | after it ends |
| `TASK_REVISION_CONFLICT` | `expectedRevision` is stale | re-read, then retry |
| `TASK_INVALID_STEPS` | bad step definition / count | fix arguments |
| `TASK_RUN_NOT_FOUND` | run missing or not owned by this Session | no |
| `TASK_RUN_ALREADY_FINISHED` | run is terminal | start a new run |
| `TASK_STEP_ORDER_INVALID` | out-of-order, unknown, or duplicate step report | fix order |
| `TASK_PERMISSION_DENIED` | archived/paused task, or missing resume confirmation | no |
| `TASK_SCHEDULE_UNAVAILABLE` | Schedule not mounted | after the host provides it |
| `TASK_SCHEDULE_FAILED` | host schedule operation failed | inspect host state |
| `TASK_STORAGE_ERROR` | StorageDomain missing, failed, or incompatible | after the host is fixed |
| `TASK_RUN_INTERRUPTED` | execution lost, marked interrupted | `task_resume` |
| `TASK_MAX_CONCURRENCY` | per-Session active-run cap reached | after a run ends |
| `TASK_INVALID_ARGUMENTS` | argument failed validation | fix arguments |
| `TASK_INTERNAL_ERROR` | unexpected runtime failure | no |

The first 13 are the PRD's stable codes; the last two are additive so an
unexpected failure is never reported as a misleading PRD code.

## Security

- **Session isolation.** Every tool entry point resolves the caller Session from
  `exec.agent.session.id` and compares it with the record owner. A record owned by
  another Session is reported as `TASK_NOT_FOUND`, so the error cannot be used to
  probe other Sessions' data.
- **No privilege escalation.** The engine never adds shell, file, browser or
  network capability. Every action runs through the Agent's already-authorized
  tools and existing approval flow.
- **Templates are data.** Step `instruction` text is user content with no
  elevated authority; a template cannot change system prompts, permissions or
  tool access. External text is rendered as untrusted single-line text.
- **No leakage.** Error messages are sanitised: stack frames dropped, absolute
  paths replaced with `<path>`, credential-looking assignments redacted.
- **No code injection.** Task arguments cannot carry JavaScript, dynamic imports
  or scripts; there is no evaluator anywhere in the plugin.
- Scheduling is bound to the creating Session, so a scheduled run executes in the
  Session that owns the task.

## Upgrade

1. Bump the bundle; the plugin row keeps its config.
2. On next start the engine opens the domain, compares the stored
   `meta.schemaVersion`, and runs any pending migration once each, recording a
   marker **only after** the migration succeeds.
3. A stored version **higher** than the plugin supports is refused with
   `TASK_STORAGE_ERROR` — downgrading is not silently allowed.

v1.0.0 ships an empty migration set (the baseline shape needs none); the runner
and ledger exist so a future shape change is a data edit plus one entry.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every tool returns `TASK_STORAGE_ERROR` mentioning `ctx.storageDomain` | the Host has no StorageDomain mounted | enable `storage` + `storage-json` + `storage-domain` in the profile |
| `invalid unit name '…'` | a domain/table name with a hyphen | the unit must match `/^[a-z][a-z0-9_]*$/` (this plugin uses `dsh_background_task_engine`) |
| `TASK_SCHEDULE_UNAVAILABLE` | `ctx.schedule` is not mounted | scheduling is optional; manual runs still work |
| Row did not activate: *cannot get property "…" without inject* | a plugin read an optional service as a property | resolve optional services via `ctx.get` |
| `TASK_REVISION_CONFLICT` | two edits raced | `task_get`, then retry with the current `revision` |
| A run is `interrupted` after a restart | the Host stopped mid-run; nothing is auto-restarted | `task_resume` with a confirmation if a step may have had side effects |
| Install rejected: *dsh.bundle.patch must be a file path* | flat manifest form | use `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |

## Development

```sh
npm install
npm run build      # tsc -> dist/
npm run typecheck
npm test           # 81 tests
```

Layout:

```text
src/
  index.ts              plugin entry: name / inject / Config / apply
  host.ts               structural host contract (no host package imports)
  config.ts             Schemastery Config + resolveConfig
  errors.ts             stable codes, payloads, message sanitisation
  domain/records.ts     zod record schemas
  domain/state.ts       TaskRun/StepRun state machines, progress, ordering
  storage/spec.ts       domain declaration, migrations, integrity check
  storage/repository.ts the only reader/writer of domain tables
  services/             audit, task, run, schedule adapter, engine
  tools/                12 tool definitions + shared plumbing
  prompt/guidance.ts    execution protocol and delivery parsing
tests/                  domain, storage, rendering, integration (+ fakes)
docs/                   API compatibility audit, test report, detail page
```

Verification records: `docs/API-COMPATIBILITY-AUDIT.md` (host capability audit,
including the real-stack runs) and `docs/TEST-REPORT.md` (all 81 assertions).

## License

MIT — see [LICENSE](LICENSE).
