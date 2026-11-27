# 03 Host install & smoke

真实宿主包（asar 内 `@deepseek-ai/dsh-*`）在一次性 cordis 上下文里挂载本插件，跑重建后的 `dist/`。

```console
$ DSH_INSTALL_DIR=.../app.asar/dsh/node_modules/@deepseek-ai/dsh \
  ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness" /tmp/v123-host2.mjs
tools visible: 14 | task_archive,task_create,task_engine_status,...
create: true tsk_... revision 1
run: true running | token prefix exec_run_n | gen 1
heartbeat: true accepted true lease 2026-11-27T09:37:25
finish: true succeeded 100%
schedule without host Schedule: {"success":false,"error":{"code":"TASK_SCHEDULE_UNAVAILABLE",...}}
history: {"success":true,"items":[{... "status":"succeeded","triggerType":"manual","progress":100 ...}]}
status: true | schedule false | integrity ok | schema 2 | tasks 1 runs 1
```

结论：14 个工具注册、建任务 → 起运行（带 `exec_` 凭证）→ 心跳续租 → 收尾 succeeded 100%，
无 Schedule 时 `task_schedule` 明确失败而不是假成功。
