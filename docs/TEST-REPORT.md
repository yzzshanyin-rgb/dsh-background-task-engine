# Test Report

Verification record for `dsh-background-task-engine` **1.2.3** against the V1.2.0
acceptance matrix (章节 14 与 V1.2.0 §2–§7 验收项), plus the release gates of the
V1.2.2 市场发布执行手册 (see `docs/RELEASE-CHECKLIST.md` and `release-evidence/v1.2.3/`).

## How to reproduce

```sh
npm install
npm run build          # tsc -> dist/
npm test               # vitest run
```

## Summary

| Suite | File | Tests | Result |
|---|---|---|---|
| Domain (state machine) | `tests/domain/state.test.ts` | 22 | PASS |
| Domain (configuration) | `tests/domain/config.test.ts` | 7 | PASS |
| Storage (records + migrations) | `tests/storage/repository.test.ts` | 18 | PASS |
| Services (time zones) | `tests/services/schedule-time.test.ts` | 13 | PASS |
| Rendering | `tests/tools/render.test.ts` | 13 | PASS |
| Integration (tools) | `tests/integration/tools.test.ts` | 35 | PASS |
| Integration (reliability) | `tests/integration/reliability.test.ts` | 20 | PASS |
| Integration (board routes) | `tests/integration/http-routes.test.ts` | 10 | PASS |
| Integration (client bundle) | `tests/integration/client-bundle.test.ts` | 17 | PASS |
| **Total** | 9 files | **155** | **all passing** |

```console
$ npx vitest run
✓ tests/domain/state.test.ts (22 tests) 5ms
 ✓ tests/integration/client-bundle.test.ts (17 tests) 137ms
 ✓ tests/storage/repository.test.ts (18 tests) 16ms
 ✓ tests/services/schedule-time.test.ts (13 tests) 28ms
 ✓ tests/integration/http-routes.test.ts (10 tests) 33ms
 ✓ tests/integration/reliability.test.ts (20 tests) 42ms
 ✓ tests/tools/render.test.ts (13 tests) 63ms
 ✓ tests/integration/tools.test.ts (35 tests) 146ms
 ✓ tests/domain/config.test.ts (7 tests) 5ms
      Tests  155 passed (155)
```

## Release gates (V1.2.3)

| 门槛 | 结果 | 证据 |
|---|---|---|
| 包完整性（72 文件、必含项齐全、无源码/测试入包） | PASS | `release-evidence/v1.2.3/01-package.md` |
| 干净克隆 `npm ci` → build → typecheck → test | PASS（155） | `release-evidence/v1.2.3/02-build-tests.md` |
| 真实宿主安装、14 工具、任务→心跳→步骤→收尾 | PASS | `release-evidence/v1.2.3/03-host-install.md` |
| StorageDomain 打开 + v1→v2 迁移 + 重复启动幂等 | PASS | `release-evidence/v1.2.3/06-migration.md` |
| 看板路由安全边界（SEC-01..06） | 已逐条记录，SEC-03 为设计限制 | `release-evidence/v1.2.3/05-security.md` |
| Schedule 真实到期投递 | **未验证**（见 04-schedule.md） | `release-evidence/v1.2.3/04-schedule.md` |

### Board route security matrix

宿主不为静态路由提供 per-request 身份（认证只覆盖 RPC 网关），`ctx.webServer` 也拒绝绑定
通配地址。因此插件在文档与 UI 里声明「本机单用户」，并由以下测试固定行为：

| 用例 | 断言 | 位置 |
|---|---|---|
| SEC-01 | 缺 `session` → 403 `TASK_PERMISSION_DENIED` | http-routes |
| SEC-02 | 列表只含本 session 任务，另一 session 为空 | http-routes |
| SEC-04 | 用他人 taskId → 404 `TASK_NOT_FOUND`（与不存在同形） | http-routes |
| SEC-05 | 畸形/超长/路径样式 session → 400 `TASK_INVALID_ARGUMENTS` | http-routes |
| SEC-06 | 写操作只认 `session` 选择器，owner 由服务端推出 | http-routes + tools |
| 部署模型 | `/status` 返回 `deploymentModel: 'local-single-user'`、`sessionVerified: false` | http-routes |

### Behaviour change in 1.2.3

`task_schedule(create|update|pause|resume|delete|run_now)` 在宿主未挂载 `ctx.schedule` 时，
原先返回 `success: true` + `scheduleAvailable: false`，现在返回 **`success: false` +
`TASK_SCHEDULE_UNAVAILABLE`**。理由：软成功会让 Agent 向用户宣称“定时已设置”，而宿主根本
没有 Schedule 服务。`action: 'status'` 仍返回 `scheduleAvailable: false` 供诊断。

`task_engine_status` 的 `taskCount` / `runCount` 改为**按调用者 session 实时统计**（不再使用
启动时缓存），避免“存储里明明有数据，诊断却说 0”。

## V1.2.0 acceptance matrix

| 验收项 | 覆盖位置 |
|---|---|
| 同一幂等键 20 并发只产生 1 个 Run | `reliability.test.ts` · 20 concurrent `manualRunId` |
| 任务级与会话级上限、结束即释放 | `reliability.test.ts` · per-task / per-owner limits |
| 写入失败释放占位后可重试 | `reliability.test.ts` · failed insert releases the reservation |
| 心跳续租、伪造凭证被拒、旧凭证不能改新运行 | `reliability.test.ts` · heartbeat & credentials |
| 运行中只标疑似失联，启动扫描才置中断 | `reliability.test.ts` · stale detection |
| Step 写成功但 Run 汇总漂移 → 重算修复 | `reliability.test.ts` · `reconcileRun` |
| 定时操作台账 + 对账不重复建规则 | `reliability.test.ts` · schedule ledger |
| 旧版本数据迁移、二次迁移为空、状态不变 | `reliability.test.ts` · v1 → v2 migration |
| 相同时间戳的稳定游标分页 | `reliability.test.ts` · 30 runs, one instant |
| 活动数据保护与批量清理 | `reliability.test.ts` · `prune` |
| 时区、跨日、夏令时、非法时区 | `schedule-time.test.ts` |
| 看板数据隔离、缺会话拒绝、跨会话 404 | `http-routes.test.ts` |
| 看板列表/详情/运行详情/空态/错误态 | `client-bundle.test.ts` · task board |

The client-bundle suite loads `client/client.js` with a `window.__ModuleLoader__`
stub and a minimal React-hooks runtime, so the shipped browser half is executed
rather than merely grepped: it asserts the slot name and key, the namespace it
edits, the eight rendered inputs, that only changed fields are written at the
observed revision, that an out-of-range value never reaches the host, and that
an unserved namespace renders an explanation instead of a dead form.

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

### Volatile-configuration check (1.1.x)

`schemastery` turns every `volatile()` field into a reference object, and the
services read through `ConfigRef.get()` on each use. Verified against the real
host packages:

```console
$ ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" /tmp/real-host-volatile.mjs
config field is a ref: true -> 3
tools: 12
4 steps under maxStepsPerTask=3 -> TASK_INVALID_STEPS
3 steps -> true 3
```

The config was parsed by the shipped `Config` with `maxStepsPerTask: 3`; a
four-step task was rejected at call time and a three-step task accepted, which
only happens if the service reads the reference instead of a value captured at
construction.

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

## Published artifact verification (npm)

After `npm publish` (registry confirms `dsh-background-task-engine@1.0.0`,
`dist-tags.latest = 1.0.0`, maintainer `anishuodedui`), the **published** package
was verified independently of the checkout:

| Check | Result |
|---|---|
| `npm view dsh-background-task-engine version` | `1.0.0`, `latest = 1.0.0` |
| `npm install dsh-background-task-engine@1.0.0` into a clean project | 5 packages, no errors |
| Load the installed copy | 26 exports; `name` / `inject` as documented |
| `apply()` on the installed copy | **12/12 tools register** |
| `Config({})` on the installed copy | documented defaults |
| Install into the real desktop profile (`@1.0.0`, not a link) | **`application: applied`**, `warnings: []` |
| Profile copy shape | real directory from the registry (not a symlink), own `node_modules` |
| Display resources in the installed copy | `locale/{en,zh}.json`, `icon.svg`, `docs/DETAIL{,.zh}.md`, `docs/preview.svg` all present |
| Locale titles | `Background task engine` / `后台任务引擎` |

### One installation hazard worth recording

`@deepseek-ai/schemastery` resolves only if the dependency is installed. When the
bundle was installed as a **registry** package immediately after the workspace
`node_modules` had been removed, the loader resolved through the stale workspace
path and failed with `ERR_MODULE_NOT_FOUND: Cannot find package
'@deepseek-ai/schemastery'`. Restoring the workspace dependencies and
reinstalling from the registry produced a clean `application: applied`.

Practical consequence: run `npm install` in the package directory before
`plugin_manager install_bundle` when handing it a directory path, and prefer the
registry spec (`dsh-background-task-engine@1.0.0`) once published — it carries its
own `node_modules` and does not depend on the checkout.

## 1.0.2 (README language) verification

Documentation-only release; code is unchanged from 1.0.0/1.0.1.

| Check | Result |
|---|---|
| `README.md` default language | Chinese |
| English document | `README.en.md`, with a language switch in both files |
| Heading anchors in the Chinese table of contents | all 10 resolve to real headings |
| Code fences | 12 per file, balanced |
| File links (`LICENSE`, `docs/*`, `README.en.md`) | all exist |
| `package.json` `description` | Chinese, matches the README |
| `files` list | `README.en.md` replaces the removed `README.zh.md` |
| `npm pack` contents | both `README.md` (12.5 kB) and `README.en.md` (12.8 kB) present |
| Published `1.0.2` installed from registry | `README.md` inside the package is Chinese; `description` Chinese |
| Build + tests | BUILD OK, 81/81 |
| Profile install of `1.0.2` | `application: applied`, 12/12 tools |

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
## Upgrade regression (1.1.1 data → 1.2.x)

The JSON backend stamps the unit version in the file header and refuses to load a
file when that version is neither the declared one nor listed in
`compatibleVersions` (`version-mismatch`). 1.2.0/1.2.1 declared version 2 without
listing 1, so a real 1.1.1 profile failed to open its own data — the engine stopped
at "storage not ready" and every tool refused to run. `createDomainSpec()` now
declares `compatibleVersions: [1]`.

Verified against a copy of the real 1.1.1 data file on this machine:

```console
$ ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" /tmp/v12-upgrade.mjs
v1 file: unit version 1 | tasks 1 | runs 2
storage: true | integrity: ok | schema: 2 | tasks: 1 | runs: 2
after: unit version 2 | tables 8 | meta schemaVersion 2
migrated applied: {"v2-run-liveness-defaults":"…","v2-build-indexes":"…","v2-step-retry-policy":"…"}
step retryPolicy present: true
run executionGeneration present: true
run statuses untouched: ["succeeded"]
```

And against the live Desktop profile after installing 1.2.2:

```console
$ curl 'http://127.0.0.1:64574/dsh-background-task/api/status?session=…'
{"success":true,"storageAvailable":true,"scheduleAvailable":true,…,"integrityStatus":"ok",
 "lastRecoveryScanAt":"2026-11-26T08:33:29.515Z","unsettledScheduleOps":0}
```

The live data file kept its 1 task / 2 runs / 6 steps, unit version became 2, and
the three v2 migrations plus the schedule reconcile and recovery scan all ran.
