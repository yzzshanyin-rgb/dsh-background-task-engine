# Changelog

All notable changes to `dsh-background-task-engine` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-26

配置页面。此前八个配置项只能写进 profile 的 `cordis.patch.yml`，插件页里没有入口。

### Added

- 浏览器半 `client/client.js`：在插件详情页注册 `plugins.bundle.config` 卡片（key 为包名），
  八个字段可编辑、可逐项恢复默认、可查看取值范围与含义。
- `dsh.client` 与 `exports["./client"]`：声明并暴露浏览器半，`files` 同步收录 `client/`。

### Changed

- **配置字段全部改为 volatile**。宿主因此可以在不重新加载插件的前提下更新配置值，
  这也是 `dsh-settings` 服务该命名空间的必要条件（只含普通字段的 schema 不会出现在配置页）。
- 服务层由「构造时读一次数字」改为「每次使用读 `ConfigRef.get()`」，所以配置卡片保存后立即生效。
  `resolveConfig()` 现在返回引用包，另提供 `configRefs()` / `configValues()` 供默认值与诊断使用。
- 加载期校验保持严格：越界值仍让插件加载失败；运行期读到漂移的手改值则回退默认，不在工具调用里抛错。

## [1.0.3] — 2026-11-26

Packaging fixes required for plugin-market listing.

### Changed

- `@deepseek-ai/schemastery` moved from `dependencies` to `peerDependencies`
  (also kept in `devDependencies` for local builds). It is a host-provided
  `@deepseek-ai/*` package, so declaring it as a peer avoids shipping a second
  copy and follows the market guidance. `zod` stays a regular dependency because
  record schemas are validated in-process regardless of the host.
- Added `assets/icon-180.png`: the market accepts raster icons only
  (`png`/`jpg`/`jpeg`/`webp`) and refuses SVG, so a 180×180 PNG is now shipped
  alongside `icon.svg` (which the DSH plugin list still uses).

## [1.0.2] — 2026-11-26

Documentation release: the default README is now Chinese.

### Changed

- `README.md` is now the Chinese document, so the npm package page and the GitHub
  repository home both render in Chinese by default.
- The previous English README moved to `README.en.md`; both files carry a
  language switch at the top. `README.zh.md` was removed (it is now `README.md`).
- `package.json` `description` is now Chinese, so the npm listing summary matches
  the README.
- `files` updated from `README.zh.md` to `README.en.md`.

## [1.0.1] — 2026-11-26

Documentation-only release.

### Fixed

- README install instructions now put the npm spec first and explain that a
  directory install needs `npm install` run first, because the plugin imports
  `@deepseek-ai/schemastery`. Without it the loader fails with
  `ERR_MODULE_NOT_FOUND` — observed and recorded while installing 1.0.0.
- Added the npm version badge.

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

### Verification

- Published as `dsh-background-task-engine@1.0.0` on npm; the registry copy was
  installed into a real profile and reports `application: applied`.
- 81 tests across domain, storage, rendering and integration suites.
- Real-host runs against the installed DSH `0.2.2-rc.3` packages: mount, full
  manual loop, restart persistence, stale-run recovery, resume.
- The published artifact was re-verified from a fresh clone: rebuild is
  byte-identical, tests pass, and the npm tarball installs and registers all 12
  tools.

### Known limitations

- Schedule delivery could not be exercised end-to-end in-process: the real
  `ScheduleService` needs `agents`, `sessions`, `sessionPersistence` and a
  session controller that only the full application composes. The adapter is
  covered against a double implementing the documented contract.
- The `json` backend stores the whole domain as one document, so write cost grows
  with retained runs; the 90-day prune bounds it.
- `domain/changed` is an in-process event; a second host process observes writes
  after reopening the domain, not live.
