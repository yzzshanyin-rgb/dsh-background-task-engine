# 08 Sign-off (Go / No-Go)

| # | 门槛 | 结论 | 证据 |
|---|---|---|---|
| 1 | npm 包完整性与版本一致 | **GO** | 01-package.md |
| 2 | 目标 DSH 版本真实安装 + 14 工具 | **GO** | 03-host-install.md |
| 3 | StorageDomain 打开与旧数据迁移 | **GO** | 06-migration.md |
| 4 | Schedule 真实投递到执行 | **NO-GO（未执行）** | 04-schedule.md |
| 5 | 看板 HTTP 认证与 Session 边界 | **GO 且已声明限制** | 05-security.md |
| 6 | 心跳/恢复/幂等/并发回归 | **GO** | 02-build-tests.md |
| 7 | 中英文文档与市场资料一致 | **GO** | 07-docs-market.md |
| 8 | 固定 Commit + Tag + Release + npm 包 | **GO**（GitHub Release 待用户凭据） | 00-baseline.md |

## 判定

七项 GO、一项 NO-GO。按手册“任一项未执行即 NO-GO”的字面要求，**本次发布整体应是 NO-GO**。

本轮的处置是：**不以“稳定版已完全验证”对外表述**——

- README 与市场文案不提“端到端已验”；
- 定时功能描述限定为“依赖 DSH 原生 Schedule，规则与投递由宿主负责”；
- 版本号继续 patch 递增（1.2.3），不宣布 1.x 稳定；
- 第 4 项的真实投递验证需要用户在自己的会话里触发一次（见下）。

## 第 4 项的执行方式（用户可自行完成）

1. 在本机 GUI 会话里让 Agent 建一个任务并执行
   `task_schedule({ action: 'create', timing: { kind: 'every', everySeconds: 120 } })`。
2. 等一次到期投递（约 2 分钟），宿主日志出现 `[SCHEDULE REMINDER]` 与 `schedule_id_json`。
3. 看板里应出现一条新运行，`triggerType: schedule`，且**投递本身不会把运行标成 succeeded**。
4. 重复投递不会重复建运行（幂等键 `schedule:<id>:<occurrence>`）。

完成后把这段记录补进 `release-evidence/v1.2.3/04-schedule.md`，第 4 项即可转 GO。
