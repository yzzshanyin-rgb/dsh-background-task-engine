# 04 Schedule real delivery (D)

## 已验证

- 定时参数→原生 timing 的转换（at / every / rrule / cron / daily / weekly），含 IANA 时区校验、
  跨日与夏令时（13 项 `tests/services/schedule-time.test.ts`，真实 `Intl` 计算）。
- 定时创建/暂停/恢复/删除的**本地台账**：意图先落盘（`pending` → `processing`），
  成功写 `succeeded` 并记录 `scheduleId`，失败写 `failed` + 脱敏 `lastError`
  （`tests/integration/reliability.test.ts` 的台账用例）。
- 启动对账：仅在能唯一确认时自动采纳/清理，歧义保留 `reconciling`，绝不盲目建删。
- 宿主无 `ctx.schedule` 时 `task_schedule` 明确报 `TASK_SCHEDULE_UNAVAILABLE`
  （见 `03-host-install.md` 实测）。
- 投递载荷识别：`parseTriggerMessage` 能从句柄文本里取出 `task_id_json` / `schedule_id_json` /
  `occurrence_at`，重复投递靠 `schedule:<id>:<occurrence>` 幂等（`tests/integration/tools.test.ts`）。

## 未验证（按手册表 14 的严格定义）

**一次真实的到期投递 → Agent 收到 → 生成 Run → 步骤回写**的完整链路，本轮没有在真实
profile 里等到一次触发。原因：手册要求的观察点是宿主在规则到期时投递消息；本轮所有验证在
一次性 cordis 上下文中完成，该上下文没有可投递的 Session 会话存储与 Agent 运行时。

因此本项按手册判定为**未完成**，市场文案只写“定时依赖 DSH 原生 Schedule，规则与投递由宿主
负责”，不宣称端到端已验证。
