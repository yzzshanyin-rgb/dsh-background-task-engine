# 发布检查清单（V1.2.3）

按《DSH Background Task Engine V1.2.2 插件市场发布执行手册》执行，版本号因修复内容变化升为
**1.2.3**（手册 §A-01 允许：修复导致版本变化时，后续步骤统一使用新版本号）。
本文件是门槛与证据的对照表；每项的证据文件位于 `release-evidence/v1.2.3/`。

| # | 门槛 | 状态 | 证据 |
|---|---|---|---|
| 1 | npm 包完整性与版本一致 | ✅ | `01-package.md`（72 文件、必含项齐全、无源码/测试泄漏） |
| 2 | 目标 DSH 版本真实安装、14 工具注册 | ✅ | `03-host-install.md` |
| 3 | StorageDomain 打开与 1.1.1 数据迁移 | ✅ | `06-migration.md` |
| 4 | Schedule 真实投递到执行链路 | ⚠️ 部分 | `04-schedule.md`（真实规则创建/暂停/删除已验；真实投递需在会话中等待一次到期） |
| 5 | 看板 HTTP 路由的认证与 Session 边界 | ✅ 已记录边界 | `05-security.md`（SEC-01..06 逐条结论） |
| 6 | 心跳/恢复/幂等/并发回归 | ✅ | `02-build-tests.md`（149 项） |
| 7 | 中英文文档与市场资料一致 | ✅ | `07-docs-market.md` |
| 8 | 固定 Commit + Tag + Release + npm 包 | ✅ | `00-baseline.md` |

## 结论

八项中第 4 项按「真实投递」的严格定义仍未完成：本机已验证创建真实规则、暂停/恢复/删除与
本地引用一致、重复投递幂等（用真实宿主 + 真实 `ctx.schedule` 的原生规则），但一次真实
到期投递需要等到规则触发时刻，期间的证据只能由用户会话产生。按手册 §D 的要求，**该项在
真实投递发生前应视为未验证**，因此市场文案与 README 均按“定时依赖 DSH 原生 Schedule、
投递由宿主完成”的措辞描述，不宣称端到端已验。

## 回滚

- 上一稳定版：`1.2.2`（npm `latest` 在本次发布前指向它）。
- 升级前必须备份 `~/.dsh/storages/dsh_background_task_engine.json`（或 profile storage root 下同名文件）。
- schema v2 数据不能交给 1.1.x 读取（旧代码声明 unit version 1，会 `version-mismatch`）。
  回退请恢复备份文件，不要手工改版本号。
