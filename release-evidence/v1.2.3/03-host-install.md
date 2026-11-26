# 03 Host install and tool registration (C-02 / C-03)

在真实宿主包（从 app.asar 加载 @deepseek-ai/cordis + dsh-storage + dsh-storage-json +
dsh-storage-domain + dsh-system-prompt + dsh-tools）中挂载**干净克隆构建产物**
`/tmp/verify-123/dist/index.js`，走真实的 `ctx.storageDomain.open` 与 `ctx.tools.register`。
存储根为一次性目录 `/tmp/host123b-root`。

脚本：`/tmp/v123-host2.mjs`（命令见下）

```
DSH_INSTALL_DIR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh" \
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" /tmp/v123-host2.mjs
```

实际输出：

```
tools visible: 14 | task_archive,task_create,task_engine_status,task_get,task_list,task_resume,task_run,task_run_begin,task_run_finish,task_run_heartbeat,task_run_history,task_schedule,task_step_report,task_update
create: true tsk_fj7vn19c9ypq0scg43zh revision 1
run: true running | token prefix exec_run_4 | gen 1
heartbeat: true accepted true lease 2026-11-26T09:38:57
finish: true succeeded 100%
schedule without host Schedule: {"success":false,"error":{"code":"TASK_SCHEDULE_UNAVAILABLE","message":"当前宿主未挂载 ctx.schedule，定时功能不可用；请用 task_run 手动执行任务，或在启用 Schedule 后重试。","retryable":false}}
history: {"success":true,"items":[{"runId":"run_4veezpyjxga4hdc8efcv","status":"succeeded","triggerType":"manual","taskRevision":1,"progress":100,"startedAt":"2026-11-26T09:08:57.534Z","finishedAt":"2026-11-26T09:08:57.763Z","summary":"真机巡检通过","steps":[{"stepId":"stp_7
status: true | schedule false | integrity ok | schema 2 | tasks 1 runs 1
```

结论：
- 14 个 `task_*` 工具全部注册并对模型可见。
- 建任务 → 取运行（带 `exec_` 前缀执行凭证与 generation 1）→ 心跳续租 → 逐步上报 → 收尾
  `succeeded 100%` 的完整链路可用。
- 宿主未挂载 `ctx.schedule` 时，`task_schedule(create)` 返回 **`success:false` +
  `TASK_SCHEDULE_UNAVAILABLE`**（不再假报成功），而 `task_run` 手动执行不受影响 —— 对应 PRD FR-012。
- `/status` 的计数来自持久化行而非缓存：本会话 1 个任务、1 次运行。
