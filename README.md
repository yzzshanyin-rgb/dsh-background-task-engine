# dsh-background-task-engine

[![npm](https://img.shields.io/npm/v/dsh-background-task-engine)](https://www.npmjs.com/package/dsh-background-task-engine)
[![license](https://img.shields.io/github/license/yzzshanyin-rgb/dsh-background-task-engine)](LICENSE)

**[English](README.en.md) | 中文**

给 **DeepSeek Harness（DSH）** 用的持久化后台任务引擎：可复用的任务模板、有序线性步骤、单次运行账本、进度与历史查询、失败/中断后的人工恢复，以及可选的 DSH 原生定时关联。

它不重写调度器、Agent Loop、作业注册表或存储后端，只复用宿主已有的 `ctx.schedule`、`ctx.storageDomain` 和 `ctx.tools`。

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

要求：DSH **0.2.2-rc.3** 或兼容版本，且已挂载 `ctx.storageDomain`（官方 base bundle 默认以 `storage-domain backend: json` 挂载）。

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

12 个模型可见工具，统一返回
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

`task_schedule` 的 action：`create`、`update`、`pause`、`resume`、`delete`、`run_now`、`status`。timing 接受 `at`、`every`、`rrule`、`cron`、`daily`、`weekly`；其中 `daily`/`weekly` 会被转换成等价的 `RRULE`，以减少对宿主 shapes 的依赖。插件只保存 `scheduleId` 与少量引用，绝不复制 Cron 状态。

## 执行协议

运行由**调用方 Agent 在自己的授权上下文中**执行。没有独立 worker 进程，也不会把
`followup` 回执当作执行完成。

1. `task_run` 或 `task_run_begin` → 取得 `runId`、模板快照与步骤列表。
2. 按 `order` 顺序对每一步调用 `task_step_report(action:"started")`。
3. 结束时报告 `task_step_report(action:"completed" | "failed" | "skipped")` 并给出真实摘要；
   `completed` 必须满足该步骤的 `completionCriteria`。
4. 缺少输入、等待审批或外部条件不满足 → `task_run_finish(status:"blocked", summary:"…")`，并在摘要中写明在等什么。
5. 全部必需步骤 completed → `task_run_finish(status:"succeeded")`。
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

StorageDomain 单元为 `dsh_background_task_engine`，schema 版本 `1`
（必须用下划线形式：宿主的单元名规则是 `/^[a-z][a-z0-9_]*$/`）。

| 表 | 主键 | 内容 |
|---|---|---|
| `tasks` | `taskId` | 模板、状态、revision、所属会话、步骤、定时引用 |
| `task_runs` | `runId` | 状态、触发来源、快照、进度、时间、摘要/错误、`resumesRunId` |
| `task_run_steps` | `runId/stepId` | 本次运行的步骤状态、尝试次数、时间、摘要/错误 |
| `meta` | `global` | `schemaVersion`、迁移台账、恢复/清理时间戳 |

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

保留策略：终态运行及其步骤行超过 `historyRetentionDays`（默认 90 天）后，会在启动时被清理。
活动运行、任务模板与审计事件永不清理。

## 配置

以 `Config`（Schemastery）导出，并在加载时二次校验；越界值会让加载失败，而不是被静默截断。

| 配置项 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `maxTasksPerOwner` | 100 | 1–1000 | 每个会话的未归档模板上限 |
| `maxStepsPerTask` | 10 | 1–10 | 单任务步骤上限（V1.0 为线性） |
| `maxActiveRunsPerOwner` | 3 | 1–20 | 每个会话并发 queued/running 上限 |
| `maxParallelRunsPerTask` | 1 | 1 | 同一任务的并行运行数（V1.0 固定） |
| `defaultTimeoutMinutes` | 60 | 1–1440 | 超时阈值，仅用于识别 |
| `staleRunAfterMinutes` | 30 | 1–1440 | 启动扫描判定 `interrupted` 的失联时长 |
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

v1.0.0 起附带空迁移集（基线结构无需迁移）；运行器与台账已就位，未来结构变更只需新增一条迁移。

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
