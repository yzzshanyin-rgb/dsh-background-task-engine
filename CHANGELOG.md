# Changelog

All notable changes to `dsh-background-task-engine` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-26

First release. Verified against DeepSeek Harness `0.2.2-rc.3`
(see `docs/API-COMPATIBILITY-AUDIT.md` and `docs/TEST-REPORT.md`).

### Added

- **Task templates**: create / list / get / update / archive, copy-from-template,
  1–10 ordered steps, `revision` optimistic locking with `TASK_REVISION_CONFLICT`
  on a stale `expectedRevision`, and soft archive that keeps all run history.
- **Runs**: one TaskRun per execution with a frozen template snapshot, so later
  template edits cannot change an in-flight run. Manual start, an explicit
  `queued → running` two-phase start, and delivery-driven start.
- **Steps**: strictly linear progression by `order`; `started` / `completed` /
  `failed` / `skipped` reports; progress always recomputed from persisted step
  rows as `floor(completed required / required total × 100)`.
- **Recovery**: `blocked` runs are recoverable; `task_resume` creates a new run
  with `resumesRunId`, carries completed steps over, and resumes at the first
  unfinished step. A resume over a failed step (which may have had side effects)
  requires an explicit `confirmation`.
- **Startup scan**: `queued`/`running` runs untouched for
  `staleRunAfterMinutes` become `interrupted` with their running step marked
  failed-and-unverified; nothing is restarted automatically.
- **Idempotency**: `manualRunId` for manual runs;
  `schedule:<scheduleId>:<occurrenceKey>` for deliveries, so a duplicated
  delivery returns the existing run instead of starting a second execution.
- **Concurrency limits**: `maxParallelRunsPerTask` (fixed at 1) and
  `maxActiveRunsPerOwner`, both checked before a run is created.
- **Session isolation**: every entry point compares the caller's Session with the
  record owner; another Session's record reports `TASK_NOT_FOUND`.
- **Persistence**: StorageDomain unit `dsh_background_task_engine` (schema v1)
  with `tasks`, `task_runs`, `task_run_steps` and a `meta` ledger; idempotent
  migration runner, startup integrity verification, and a 90-day retention prune
  that never touches active runs or templates.
- **Schedule integration**: optional native linkage through `ctx.schedule`
  (`create` / `update` / `pause` / `resume` / `delete` / `run_now` / `status`).
  Host failures map to `TASK_SCHEDULE_FAILED` and are never reported as success;
  a missing Schedule yields `TASK_SCHEDULE_UNAVAILABLE` while manual runs keep
  working. `daily`/`weekly` inputs are expressed as an equivalent `RRULE`.
- **12 tools**: `task_create`, `task_list`, `task_get`, `task_update`,
  `task_archive`, `task_schedule`, `task_run`, `task_run_begin`,
  `task_step_report`, `task_run_finish`, `task_run_history`, `task_resume` —
  each with an input schema, a canonical output schema and a renderer.
- **Uniform error envelope** with the 13 PRD codes plus
  `TASK_INVALID_ARGUMENTS` and `TASK_INTERNAL_ERROR`; all messages sanitised
  (no stacks, host paths or credentials).
- **Display resources**: localized `meta.title` / `meta.description`
  (en + zh), a detail document, and an original SVG icon.
- **Docs**: README (en + zh) covering install, tools, protocol, model, config,
  errors, security, upgrade and troubleshooting; API compatibility audit; test
  report.

### Known limitations

- Schedule delivery could not be exercised end-to-end in-process: the real
  `ScheduleService` needs `agents`, `sessions`, `sessionPersistence` and a
  session controller that only the full application composes. The adapter is
  covered against a double implementing the documented contract.
- The `json` backend stores the whole domain as one document, so write cost grows
  with retained runs; the 90-day prune bounds it.
- `domain/changed` is an in-process event; a second host process observes writes
  after reopening the domain, not live.
