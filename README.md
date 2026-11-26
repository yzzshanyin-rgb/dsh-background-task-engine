# dsh-background-task-engine

[![npm](https://img.shields.io/npm/v/dsh-background-task-engine)](https://www.npmjs.com/package/dsh-background-task-engine)
[![license](https://img.shields.io/github/license/yzzshanyin-rgb/dsh-background-task-engine)](LICENSE)

**[English](README.en.md) | 中文**

给 **DeepSeek Harness（DSH）** 用的持久化后台任务引擎：可复用的任务模板、有序线性步骤、单次运行账本、进度与历史查询、失败/中断后的人工恢复，以及可选的 DSH 原生定时关联。

它不重写调度器、Agent Loop、作业注册表或存储后端，只复用宿主已有的 `ctx.schedule`、`ctx.storageDomain` 和 `ctx.tools`。
**让 DSH 从“能够执行任务的 AI Agent”，进一步变成“能够规范管理、持续推进、追踪和恢复任务的 AI 工作平台”**

- [安装](#安装)
- [工具](#工具)
- [执行协议](#执行协议)
- [数据模型](#数据模型)
- [配置](#配置)
- [错误码](#错误码)
- [安全](#安全)
- [升级](#升级)
- [排障](#排障)
- [开发](#开发)

## 安装

要求：DSH **0.2.2-rc.3**（Node 运行时 22+；实际验证于 Node 24.13.0）或兼容版本，
且已挂载 `ctx.storageDomain`（官方 base bundle 默认以 `storage-domain backend: json` 挂载）。

已验证的宿主接口（V1.2.0 基线，详见 `docs/API-COMPATIBILITY-AUDIT.md`）：
`ctx.tools.register`、`ctx.storageDomain.open`、`ctx.schedule.create/edit/view/run`、`ctx.webServer.register`、插件配置表单（volatile）。

```sh
# 从 npm 安装（已发布 1.0.2）
dsh plugin --profile <名称> add dsh-background-task-engine

# 或从本地目录安装
dsh plugin --profile <名称> add /绝对路径/dsh-background-task-engine
```

**用目录方式安装时，请先在该目录执行 `npm install`。** 插件会 `import '@deepseek-ai/schemastery'`，缺少 `node_modules` 时宿主会报
`ERR_MODULE_NOT_FOUND`。走 registry 规格则自带依赖，不需要本地 checkout。

也可以直接在应用内操作：**插件** 页面 → **添加插件** → 粘贴 `dsh-background-task-engine` → 安装 → 启用。

安装后重启应用，在 **插件** 页面确认 `background-task-engine` 一行已启用；该行会显示本包的标题、描述与图标。

bundle patch 除插件行外不含任何其他内容，因此安装它不会改动任何别的设置：

```yaml
- insert:
    - id: background-task-engine
      name: 'dsh-background-task-engine'
      config: { ... }
```

## 工具

14 个模型可见工具，统一返回
`{ success: true, ... }` 或 `{ success: false, error: { code, message, retryable, relatedRunId? } }`。

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `task_create` | 创建模板（1–10 步） | `title`、`description?`、`steps[]`、`copyFromTaskId?` |
| `task_list` | 列出本会话的模板 | `status?`、`query?`、`limit?`、`cursor?` |
| `task_get` | 读取单个模板与最近运行 | `taskId`、`includeRuns?` |
| `task_update` | 修改标题/描述/步骤/状态 | `taskId`、`expectedRevision`、变更字段 |
| `task_archive` | 软归档，保留历史 | `taskId`、`expectedRevision` |
| `task_schedule` | 管理原生定时关联 | `taskId`、`action`、`timing?`、`scheduleRule?` |
| `task_run` | 立即手动执行 | `taskId`、`manualRunId?`、`defer?` |
| `task_run_begin` | 认领一次运行（任务 / 排队中的运行 / 投递原文） | `taskId?`、`runId?`、`triggerPayload?`、`scheduleId?`、`occurrenceKey?`、`idempotencyKey?` |
| `task_step_report` | 上报步骤状态 | `runId`、`stepId`、`action`、`summary?`、`error?` |
| `task_run_finish` | 提交运行结果 | `runId`、`status`、`summary?`、`error?` |
| `task_run_history` | 分页查询运行历史 | `taskId`、`status?`、`limit?`、`cursor?` |
| `task_resume` | 恢复失败/中断/阻塞的运行 | `runId`、`confirmation?` |
| `task_run_heartbeat` | 上报心跳并续租，防止被误判失联 | `runId`、`executionToken?`、`note?` |
| `task_engine_status` | 查引擎诊断：存储/定时可用性、活动与中断计数、完整性、最近扫描 | `includeIntegrity?` |

`task_schedule` 的 action：`create`、`update`、`pause`、`resume`、`delete`、`run_now`、`status`。timing 接受 `at`、`every`、`rrule`、`cron`、`daily`、`weekly`；其中 `daily`/`weekly` 会被转换成等价的 `RRULE`，以减少对宿主 shapes 的依赖。插件只保存 `scheduleId` 与少量引用，绝不复制 Cron 状态。

## 任务看板

输入框下方有一个「📋 任务」入口，展开是本会话的任务看板：

- **列表**：名称、状态、触发方式、最近运行结果、更新时间；支持按状态筛选、按名称搜索、按更新时间排序。
- **任务详情**：步骤、定时状态与下次执行时间、定时操作台账（含失败原因）、最近 20 次运行。
- **运行详情**：步骤时间线（等待/执行中/已完成/失败/跳过）、开始与完成时间、失败原因与类别、最近心跳与租约、
  是否需要人工确认；恢复按钮会带上人工确认说明。
- **操作**：暂停、恢复、归档、恢复运行。所有写操作与服务端工具走同一套权限与状态校验，页面不做本地判断。

看板数据来自插件自己的宿主路由 `/dsh-background-task/api/*`，按当前会话过滤；插件不提供会话枚举接口，
也不会用别的会话去查数据。会话取自插槽参数/启动清单/地址栏，都取不到时会请你粘贴一次 Session ID。

## 执行协议

运行由**调用方 Agent 在自己的授权上下文中**执行。没有独立 worker 进程，也不会把
`followup` 回执当作执行完成。

1. `task_run` 或 `task_run_begin` → 取得 `runId`、模板快照与步骤列表。
2. 按 `order` 顺序对每一步调用 `task_step_report(action:"started")`。
3. 结束时报告 `task_step_report(action:"completed" | "failed" | "skipped")` 并给出真实摘要；
   `completed` 必须满足该步骤的 `completionCriteria`。
4. 缺少输入、等待审批或外部条件不满足 → `task_run_finish(status:"blocked", summary:"…")`，并在摘要中写明在等什么。
5. 全部必需步骤 completed → `task_run_finish(status:"succeeded")`。
   步骤较长（外部命令、大批量文件）时，在步骤之间调用 `task_run_heartbeat(runId: …)`，
   让看板与引擎知道你还在跑，而不是失联。
6. 失败 → 先 `task_step_report(action:"failed", error:{…})`，**再**
   `task_run_finish(status:"failed")`。

进度恒为 `floor(已完成必需步骤数 / 必需步骤总数 × 100)`，并且始终由已持久化的步骤记录重算——不采信调用方自报。

### 定时触发

`task_schedule` 创建时会把带 `task_id_json` 的提示词写入宿主定时任务。投递到达后：

```text
task_run_begin({ triggerPayload: "<投递消息原文>" })
```

工具会从中提取 `task_id_json`、`schedule_id_json` 与 `occurrence_at`，并以
`schedule:<scheduleId>:<occurrence>` 作为幂等键。重复投递会返回已有运行并标记
`deduplicated: true`，不会重复启动。**投递只证明消息已入队，不代表运行完成。**

## 数据模型

StorageDomain 单元为 `dsh_background_task_engine`，schema 版本 `2`
（必须用下划线形式：宿主的单元名规则是 `/^[a-z][a-z0-9_]*$/`）。

| 表 | 主键 | 内容 |
|---|---|---|
| `tasks` | `taskId` | 模板、状态、revision、所属会话、步骤、定时引用 |
| `task_runs` | `runId` | 状态、触发来源、快照、进度、时间、摘要/错误、`resumesRunId`、心跳/租约/执行凭证/失败类别 |
| `task_run_steps` | `runId/stepId` | 本次运行的步骤状态、尝试次数、时间、摘要/错误、失败类别、恢复策略 |
| `idempotency` | `taskId/idempotencyKey` | 幂等占位（`reserved`/`committed`），创建失败会被释放 |
| `active_runs` | `runId` | 并发名额索引，按会话/任务计数，结束即释放 |
| `run_index` | `taskId/startedAt/runId` | 按任务与开始时间的键集索引，供历史分页 |
| `schedule_ops` | `operationId` | 定时操作台账：pending/processing/succeeded/failed/reconciling + `lastError` |
| `meta` | `global` | `schemaVersion`、迁移台账、恢复/清理/对账时间戳 |

状态机：

```text
Task     active → paused → active          active/paused → archived（终态）
TaskRun  queued → running → succeeded | failed | blocked | interrupted
         queued → skipped
         blocked → failed | interrupted   （绝不回到 running）
```

`failed`、`succeeded`、`interrupted`、`skipped` 均为终态。恢复总是创建**新的**运行并写入
`resumesRunId`；已完成步骤会被结转，从第一个未完成步骤继续；若失败步骤可能已产生副作用，
必须提供显式的 `confirmation`。

进度按「已完成必需步骤 ÷ 必需步骤总数」以 floor 计算，失败与跳过不计为完成；
`task_runs` 上缓存的 `progress`/`currentStepId` 由步骤状态重算，漂移时 `task_run_begin` 或
`task_engine_status` 之后的重算会修回（`reconcileRun`），因此步骤表始终是事实来源。

保留策略：终态运行及其步骤行超过 `historyRetentionDays`（默认 90 天）后，会在启动时分批清理
（每批 200 条，清理失败不影响正常执行）。活动运行、任务模板与审计事件永不清理。

### 心跳、租约与失联

每次运行拿到一个 `executionToken` 与 `executionGeneration`。`task_run_heartbeat`、
`task_run_begin` 与 `task_step_report` 都会刷新 `lastHeartbeatAt` 并顺延 `leaseExpiresAt`：

- 超过 `defaultTimeoutMinutes` 只标记 **超时**，不等于失败；
- 超过 `staleRunAfterMinutes` 无心跳且进程仍在，只标记 **疑似失联**（写 `staleDetectedAt`），
  不会自动重跑任何步骤；
- 只有启动扫描能确认原执行已不在（宿主重启）时，才把运行置为 `interrupted` 并标记
  `needsUserConfirmation=true`——因为无法核验外部副作用是否已经发生；
- 恢复会生成新的 `executionToken`，旧凭证不能再修改新运行（`TASK_RUN_INTERRUPTED`）。

## 配置

八个数值都在「**设置 → 插件 → dsh-background-task-engine**」的配置卡片里改，**保存后立即生效，无需重启**。
也可以直接写 profile 的 `cordis.patch.yml`；两条路径写的是同一份配置。

以 `Config`（Schemastery）导出，并在加载时二次校验；越界值会让加载失败，而不是被静默截断。

> **为什么保存能立即生效**：每个字段都声明为 volatile，宿主因此把配置作为可原地更新的引用交给插件，
> 插件每次使用都读当前值。volatile 也是配置卡片存在的前提——`dsh-settings` 只服务至少含一个
> volatile 字段的命名空间，全是普通字段的 schema 在插件页里根本画不出表单。

| 配置项 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `maxTasksPerOwner` | 100 | 1–1000 | 每个会话的未归档模板上限 |
| `maxStepsPerTask` | 10 | 1–10 | 单任务步骤上限（V1.0 为线性） |
| `maxActiveRunsPerOwner` | 3 | 1–20 | 每个会话并发 queued/running 上限 |
| `maxParallelRunsPerTask` | 1 | 1 | 同一任务的并行运行数（V1.0 固定） |
| `defaultTimeoutMinutes` | 60 | 1–1440 | 单次运行的最长时间，超时只做标记，不判失败 |
| `staleRunAfterMinutes` | 30 | 1–1440 | 无心跳多久算失联（心跳间隔的基准），与超时是两个独立阈值 |
| `historyRetentionDays` | 90 | 1–3650 | 终态运行保留天数 |
| `maxSummaryChars` | 2000 | 100–10000 | 摘要截断上限 |

## 错误码

| 错误码 | 含义 | 可重试 |
|---|---|---|
| `TASK_NOT_FOUND` | 任务不存在，或不属于当前会话 | 否 |
| `TASK_ALREADY_RUNNING` | 该任务已有活动运行 | 运行结束后 |
| `TASK_REVISION_CONFLICT` | `expectedRevision` 已过期 | 重新读取后重试 |
| `TASK_INVALID_STEPS` | 步骤定义或数量非法 | 修正参数 |
| `TASK_RUN_NOT_FOUND` | 运行不存在，或不属于当前会话 | 否 |
| `TASK_RUN_ALREADY_FINISHED` | 运行已进入终态 | 创建新运行 |
| `TASK_STEP_ORDER_INVALID` | 步骤顺序错误、未知步骤或重复上报 | 修正执行顺序 |
| `TASK_PERMISSION_DENIED` | 任务已归档/暂停，或缺少恢复确认 | 否 |
| `TASK_SCHEDULE_UNAVAILABLE` | 未挂载 Schedule | 宿主提供后 |
| `TASK_SCHEDULE_FAILED` | 宿主定时操作失败 | 核对宿主状态 |
| `TASK_STORAGE_ERROR` | StorageDomain 缺失、失败或不兼容 | 宿主修复后 |
| `TASK_RUN_INTERRUPTED` | 执行丢失，已标记中断 | 用 `task_resume` |
| `TASK_MAX_CONCURRENCY` | 达到该会话的活动运行上限 | 运行结束后 |
| `TASK_INVALID_ARGUMENTS` | 参数校验失败 | 修正参数 |
| `TASK_INTERNAL_ERROR` | 未预期的运行时错误 | 否 |

前 13 个是 PRD 规定的稳定错误码；后两个为补充码，用来确保意外失败不会被误报成 PRD 错误码。

失败结果还会带结构化字段，便于 Agent 与界面直接展示，而不必解析文案：

```json
{
  "success": false,
  "error": {
    "code": "TASK_STEP_ORDER_INVALID",
    "message": "步骤 3 还不能开始，先完成步骤 2。",
    "retryable": false,
    "failedStepId": "stp_3",
    "failedAt": "2026-11-26T09:12:00.000Z",
    "failureCategory": "agent_error",
    "needsUserConfirmation": false
  }
}
```

## 安全

- **会话隔离。** 每个工具入口都从 `exec.agent.session.id` 解析调用方会话并与记录归属比对。
  属于其他会话的记录一律报 `TASK_NOT_FOUND`，因此该错误无法被用来探测他人的数据。
- **不提升权限。** 引擎不新增 Shell、文件、浏览器或网络能力；所有动作都走 Agent 已授权的
  工具与既有审批流程。
- **模板只是数据。** 步骤的 `instruction` 是用户内容，不具更高权限；模板无法改变系统提示、
  权限或工具可用性。外部文本按不可信单行文本渲染。
- **不泄露。** 错误信息经过净化：丢弃堆栈、把绝对路径替换为 `<path>`、脱敏疑似凭据的赋值。
- **不可注入代码。** 任务参数无法携带 JavaScript、动态 import 或脚本；插件内不存在任何求值器。
- 定时任务绑定创建时的会话，因此到期执行发生在拥有该任务的会话内。

## 升级

1. 升级 bundle；插件行会保留其配置。
2. 下次启动时，引擎打开 domain、比对已存 `meta.schemaVersion`，并逐条执行尚未应用的迁移，
   **只有迁移成功后**才写入台账标记。
3. 若已存版本**高于**插件支持的版本，直接以 `TASK_STORAGE_ERROR` 拒绝——不允许静默降级。

迁移都是可重复执行的（以 `meta.appliedMigrations` 为台账），V1.2.0 带来三条：

| 迁移 | 作用 |
|---|---|
| `v2-run-liveness-defaults` | 旧运行补 `schemaVersion=2`、`executionGeneration=1`、`lastHeartbeatAt=原 updatedAt`；**不设租约、不改状态** |
| `v2-build-indexes` | 从运行表重建幂等表、活动索引与按任务索引 |
| `v2-step-retry-policy` | 旧步骤补默认恢复策略 `verify_before_retry` |

旧数据不会被误标为中断或失败：缺心跳字段只意味着「未知」，不意味着「已失效」。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 所有工具都报 `TASK_STORAGE_ERROR` 并提到 `ctx.storageDomain` | Host 未挂载 StorageDomain | 在 profile 中启用 `storage` + `storage-json` + `storage-domain` |
| `invalid unit name '…'` | domain/表名里含连字符 | 单元名必须匹配 `/^[a-z][a-z0-9_]*$/`（本插件用 `dsh_background_task_engine`） |
| `TASK_SCHEDULE_UNAVAILABLE` | 未挂载 `ctx.schedule` | 定时是可选能力，手动执行不受影响 |
| 插件行未激活：*cannot get property "…" without inject* | 以属性方式读取了可选服务 | 可选服务应通过 `ctx.get` 解析 |
| `TASK_REVISION_CONFLICT` | 两次修改竞争 | 先 `task_get`，再用最新 `revision` 重试 |
| 重启后运行变成 `interrupted` | 宿主中途停止，且不会自动重启 | 若某步骤可能有副作用，带 `confirmation` 调用 `task_resume` |
| 安装被拒：*dsh.bundle.patch must be a file path* | 清单用了扁平写法 | 改用 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| 运行被标记「疑似失联」但进程还在 | 长步骤没有上报心跳 | 在步骤之间调用 `task_run_heartbeat`，或把 `staleRunAfterMinutes` 调大 |
| 定时任务在跨日时早/晚一天触发 | 旧版本用 UTC 日期拼墙上时间 | 1.2.0 已改为按目标时区的本地日期生成 DTSTART；确认 `timeZone` 是合法 IANA 名 |
| 任务看板显示「无法自动识别当前会话」 | 宿主插槽没有传会话 | 粘贴一次 Session ID（只需一次，之后记在本地） |

## 开发

```sh
npm install
npm run build      # tsc -> dist/
npm run typecheck
npm test           # 81 个用例
```

目录结构：

```text
src/
  index.ts              插件入口：name / inject / Config / apply
  host.ts               结构化宿主契约（不 import 宿主包）
  config.ts             Schemastery Config + resolveConfig
  errors.ts             稳定错误码、错误载荷、消息净化
  domain/records.ts     zod 记录 schema
  domain/state.ts       TaskRun/StepRun 状态机、进度、顺序守卫
  storage/spec.ts       domain 声明、迁移、完整性校验
  storage/repository.ts 唯一读写 domain 表的地方
  services/             审计、任务、运行、定时适配、引擎
  tools/                12 个工具定义与共用管道
  prompt/guidance.ts    执行协议与投递解析
tests/                  domain、storage、渲染、集成（含假件）
docs/                   宿主能力审计、测试报告、详情页
```

验证记录：`docs/API-COMPATIBILITY-AUDIT.md`（宿主能力审计，含真实宿主栈运行）与
`docs/TEST-REPORT.md`（全部 81 条断言）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
