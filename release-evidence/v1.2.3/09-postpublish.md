# 09 Post-publish verification (发布后冒烟)

发布后按普通用户路径复验：先移除旧版，再以 registry 规格安装。

| 步骤 | 命令 | 结果 |
|---|---|---|
| 卸载旧版 | `plugin_manager remove_bundle dsh-background-task-engine` | `applied`，移除 1.2.2 |
| 安装新包 | `plugin_manager install_bundle dsh-background-task-engine@1.2.3` | `applied`，`warnings: []`，锁文件通过供应链策略（405 条目） |
| 安装产物 | `~/.dsh/profiles/desktop/node_modules/dsh-background-task-engine` | `version 1.2.3`，`engines {node: >=22, dsh: >=0.2.2-rc.3}`，`assets/` 内 `icon-180.png` 与 `preview-1280.png` 就位 |
| 引擎自检 | `GET /dsh-background-task/api/status?session=<会话>` | `storageAvailable: true`、`scheduleAvailable: true`、`integrityStatus: "ok"`、`unsettledScheduleOps: 0`、`deploymentModel: "local-single-user"`、`sessionVerified: false` |
| 看板列表 | `GET /dsh-background-task/api/tasks?session=<会话>` | 1 条任务「DSH 升级后插件兼容性检查」，`trigger: schedule`，最近运行 `health: finished` |
| 参数校验 | `GET /tasks?session=a` | **400**（SEC-05 生效） |
| 任务详情 | `GET /task?session=<会话>&taskId=…` | 2 次运行均为 manual、`succeeded`、100% |

## 说明

- 上面这条任务是 1.2.x 早期通过工具建的，已带真实 `scheduleId`；它的两次运行都是手动触发，
  因此**不能**作为“定时到期投递”的证据（见 `04-schedule.md`）。
- `dist-tags.latest` 在发布后约 5 分钟才变为 1.2.3，期间 tarball 404 属正常传播延迟。
