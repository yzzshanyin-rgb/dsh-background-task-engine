# 06 Migration regression

本次不含 schema 变更（仍为 v2），但按手册要求复跑升级回归，确认 1.2.4 仍能打开旧文件且迁移幂等。

```console
$ ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness" /tmp/v123-migration.mjs
seed v1 file: unit.version 1 | tables 4 | tasks 1 | runs 3 | statuses ["succeeded"]
open #1: storage true | integrity ok | schema 2 | tasks 1 | runs 3
open #1 applied: 3 migrations | unit.version 2 | tables 8
open #1 run statuses: ["succeeded"] | unchanged: true
open #2: storage true | integrity ok | schema 2 | tasks 1 | runs 3
open #2 idempotent: applied still 3 | runs byte-identical: true
```

真实 profile 的数据文件在升级到 1.2.4 后仍为 `unit version 2 / 8 张表`，
`tasks 1 / task_runs 3 / task_run_steps 9`，升级未改动任何运行状态。
