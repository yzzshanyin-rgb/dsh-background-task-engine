# Changelog

All notable changes to `dsh-background-task-engine` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.4] - 2026-11-27

并发与定时一致性的加固补丁：把「检查 → 占位 → 落库」真正收进同一临界区，
并让定时操作只有在宿主规则与本地关联都被核验后才算成功。

### Fixed

- **跨任务并发上限可被绕过**：`task_run` 原先只在 `start:<owner>:<task>` 上加锁，
  同一会话对**不同任务**并发发起时，各自持有不同的锁，都能通过 `maxActiveRunsPerOwner`
  检查。改为每个 owner 一把共享锁，`TaskService` 与 `RunService` 复用同一实例，
  任务创建、更新、归档与定时变更也不再与运行创建交错。
- **定时操作与本地写入不是原子的**：`task_schedule` 先在宿主建规则、再改本地任务，
  本地写失败时会留下「宿主有规则、本地无引用」的孤儿。现在本地写入被移进
  `ScheduleLedger.run()` 的临界区，失败即整体标记为 `failed` 并由对账认领。
- **对账过于乐观**：`update` / `pause` / `resume` 原先只要宿主规则存在就判 `succeeded`，
  即使本地 `scheduleRef` 从未更新、或宿主上的实际时间规则与请求不符。现在要求
  宿主 timing、本地 timing 与操作意图三者一致才算成功，否则留 `reconciling` 交人工判断；
  宿主读取抛错也不再被当成「规则不存在」。
- **回滚不完整**：创建失败时漏删 `run_index` 与 `active_runs` 占位，可能让并发计数久占不减；
  现在按索引 → 占位 → 运行 → 步骤 → 幂等占位的顺序清理。
- **状态索引陈旧**：`begin` / `reportStep` 在状态变化后未刷新 `run_index` 与租约，
  历史查询会按旧状态过滤；`listRunIndexByTask` 现在以运行记录本身的状态为准，
  索引只用于分页键。
- **任务列表的最近运行**：同一毫秒内启动的运行按 `runId` 兜底比较，不再依赖插入顺序的偶然结果。
- **损坏的游标**：任务列表改走统一的 `decodeCursor`，畸形游标按第一页处理而不是抛错。
- `KeyedMutex` 在无等待者时删除 `tails` 条目（长跑进程里的 key 泄漏）。

### Tests

- 6 项新用例（155 项全绿）：跨任务并发上限、重叠请求只建一条宿主规则、
  本地写失败后的对账认领、删除操作需两侧都落地才结算、历史按真实运行状态过滤、
  最近五次运行排序与畸形游标。

## [1.2.3] - 2026-11-26

发布就绪补丁（按《插件市场发布执行手册》逐项核对后的修复，无业务行为变更）。

### Added

- `assets/preview-1280.png` 与 `screenshots.json`：市场详情页截图（1280×600 PNG）。
- README 新增「支持范围」表（DSH / Node / 存储 / 调度 / 平台，声明值与实测值分列）、
  「部署模型与已知边界」（本机单用户、看板路由无逐请求认证、会话标识不是身份）、
  「清理行为」（启动时分批清理，非常驻定时器）、升级前备份与 schema v2 不可回退说明。
- 看板面板底部显示部署模型提示；`/status` 返回 `deploymentModel: 'local-single-user'` 与
  `sessionVerified: false`，把安全边界显式化而不是留给读者猜。

### Fixed

- `package-lock.json` 根包版本停留在 1.0.3 → 同步到 1.2.3。
- `files` 白名单缺少 `assets`，导致 `assets/icon-180.png` 与预览图不进 tarball；
  市场条目的图标指向该文件，缺它会让详情页图标 404。
- `files` 声明了 `screenshots.json` 但仓库没有该文件。
- `engines` 缺 `dsh`，且 `node` 写 `>=20` 与 README 的「Node 22+」不一致。

### Security

- 看板路由的 `session` 参数改为强校验（长度、字符集、前缀），畸形值返回
  `TASK_INVALID_ARGUMENTS`（400）而不是退化成宽松查询。
- 明确记录：宿主对静态路由不做认证，因此本插件不宣称支持多人共享或公网部署。

## [1.2.2] — 2026-11-26

修一个会让升级后插件直接起不来的问题。

### Fixed

- 存储单元声明的 `compatibleVersions: [1]`。宿主的 JSON 后端在加载时把文件头里的
  `unit.version` 与声明版本比对，不一致且不在 `compatibleVersions` 里就抛 `version-mismatch`；
  1.1.x 的数据文件是版本 1，而 1.2.x 声明版本 2 —— 结果 `ctx.storageDomain.open()` 失败，
  引擎停在“存储未初始化”，工具全部不可用（真实 profile 上就是这样）。
  现在 1.1.x 的文件可以正常打开，三条 v2 迁移就地升级，写回后版本自然变成 2。

### Tests

- 新增 1 项：声明版本与 `compatibleVersions` 的契约断言。
- 真实宿主回归：把 1.1.1 留下的真实数据文件复制一份，用 1.2.x 打开 —— 1 个任务、2 次运行
  全部保留，状态不变，`retryPolicy`/`executionGeneration` 回填，8 张表，完整性 ok。

## [1.2.1] — 2026-11-26

让执行凭证真的可用。

### Fixed

- `task_run` / `task_run_begin` / `task_run_history` 的返回里补上 `executionToken` 与
  `executionGeneration`。1.2.0 虽然在服务端生成了凭证并逐次校验，却没有把凭证交给 Agent，
  导致心跳与步骤汇报只能走「缺凭证放行并给 warning」的兼容分支。

### Tests

- 新增 2 项：启动运行时返回可用的 `exec_` 凭证与代际 1；心跳接受真实凭证、拒绝伪造凭证
  （`TASK_RUN_INTERRUPTED`）。合计 146 项。

## [1.2.0] — 2026-11-26

可靠性加固与任务管理界面。此版本不改变既有工具的参数语义，也不重建数据模型，
只增加必要字段与索引；1.1.x 的数据在首次启动时自动迁移。

### Added

- **`task_run_heartbeat`**：上报心跳并续租；可带 `executionToken`，旧凭证不能修改已恢复的运行。
- **`task_engine_status`**：存储/定时可用性、活动/待处理/中断运行数、完整性状态、最近恢复扫描与
  对账时间、未完成定时操作数，以及最近 5 次运行的健康度。
- **任务看板**（浏览器半）：输入框下方的「📋 任务」入口，含任务列表（筛选/搜索/排序）、任务详情
  （步骤、定时状态与下次执行时间、定时操作台账、最近运行）与运行详情（步骤时间线、失败原因、
  心跳与租约、是否需要人工确认），并可暂停/恢复/归档/恢复运行。
- 宿主路由 `/dsh-background-task/api/{status,tasks,task,run,action}`：按会话过滤，不提供会话枚举，
  写操作复用服务层的权限与状态校验。
- 幂等占位表、活动运行索引表、按任务索引表、定时操作台账表；历史分页改用键集游标。
- `executionToken` / `executionGeneration`：运行执行凭证与代际。
- 步骤级 `retryPolicy`（`safe_retry` / `verify_before_retry` / `manual_only`）与 `failureCategory`。

### Fixed

- **时区日期偏移**：`daily`/`weekly` 改用目标时区的本地日期生成 `DTSTART`，不再用 UTC 日期拼墙上时间；
  跨日与夏令时都按 IANA 规则折算，非法时区名返回明确错误（旧实现在上海时间 23:30 之后会错一天）。
- **幂等竞态**：查询、并发额度校验、占位与写入现在位于同一个按键串行的临界区，20 个并发请求只产生 1 次运行。
- **并发额度**：改为按持久化索引计数，重启后按状态重建，结束即释放，清理与恢复不会误释放仍在执行的运行。
- **步骤状态**：转移校验移入存储写入的 mutator 内，并发上报不再依赖锁外快照，非法转移不会覆盖已完成步骤。
- **运行汇总漂移**：`progress`/`currentStepId` 由步骤状态重算，写入失败后可由 `reconcileRun` 修复。
- **失联判定**：超时与失联分开；运行中只标记「疑似失联」，仅启动扫描确认后置为 `interrupted`，
  且一定会标记 `needsUserConfirmation`——失联不代表可以重跑可能已产生副作用的步骤。
- **`blocked` 语义**：不再写入 `finishedAt`，因为它不是终态；恢复时旧凭证失效、代际递增。
- **失败证据**：`task_run_finish(status:"failed")` 未带 `error` 时会从失败步骤派生摘要与类别，
  不会只留下一个没有原因的 `failed`。
- **定时操作台账**：创建/修改/暂停/恢复/删除先记 `pending`，成功记 `succeeded`，失败记 `failed`
  并保留脱敏后的 `lastError`；启动时对账，只在能唯一确认时自动修复，有歧义保留 `reconciling`。
- **完整性诊断**：8 类问题（孤立步骤、缺失任务、快照缺步骤、索引漂移、并发占位漂移、幂等漂移、
  进度漂移、过期占位），并区分可自动修复与需人工介入。
- **历史分页**：`task_run_history` 默认 20、上限 50，基于 `taskId/startedAt/runId` 的键集游标，
  同一时间戳的多条运行翻页不重复、不遗漏。
- **清理**：分批（每批 200）清理过期终态运行，保护活动运行，记录处理数量与时间，失败不影响执行。

### Changed

- `task_run_finish` 的 `failed` 可省略 `error`（会从失败步骤派生）；`blocked` 仍是可恢复状态。
- 归档任务不再允许恢复运行（`TASK_PERMISSION_DENIED`），与启动运行的规则一致。
- 并发超限的错误会带上 `relatedRunId`，Agent 可以直接知道在等哪一次运行。
- 历史行新增 `resumesRunId`、`needsUserConfirmation` 与步骤摘要。

### Migration

- `v2-run-liveness-defaults` / `v2-build-indexes` / `v2-step-retry-policy`，均幂等，
  以 `meta.appliedMigrations` 为台账；旧运行不会被改成中断或失败。

## [1.1.1] — 2026-11-26

配置卡片的命名空间发现改为按事实判断，而不是假设行 id。

### Changed

- 卡片注册前的命名空间解析改为订阅 `configForms.describe()` 镜像：优先用 profile 行 id
  （`background-task-engine` / 包名），找不到时按 schema 特征（八个配置字段名）认领。
  行 id 被改写、或宿主调整 id 规则时，配置卡片仍然出现；完全不相关的命名空间不会被误认。

### Tests

- 新增两项：行 id 无关但 schema 匹配时认领成功；服务中的命名空间与本插件无关时不注册卡片（100 项全通过）。

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
