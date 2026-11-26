# 06 Migration: 1.1.1 → 1.2.3 (F-01)

用真实数据文件改造成 **真正的 v1 形态**（`unit.version=1`、4 张表、删掉 v2 新增表的全部行、
剥掉 run/step 的 v2 字段、`meta.schemaVersion=1`、迁移台账清空），再交给本版本打开。

脚本：`/tmp/v123-migration.mjs`（挂载真实宿主包 + 干净克隆产物）

```
seed v1 file: unit.version 1 | tables 4 | tasks 1 | runs 2 | statuses ["succeeded"]
seeded owner session: session-bc90f29f-7252-434a-8afb-325bae7705a8
open #1: storage true | integrity ok | schema 2 | tasks 1 | runs 2
open #1 applied: 3 migrations | unit.version 2 | tables 8
open #1 run statuses: ["succeeded"] | unchanged: true
open #2: storage true | integrity ok | tasks 1 | runs 2
open #2 idempotent: applied still 3 | runs byte-identical: true
```

结论：
- v1 文件被接受（`compatibleVersions: [1]` 生效），三条 v2 迁移各自只执行一次，单元版本升到 2，
  表从 4 张扩到 8 张。
- **旧记录状态未被改动**：运行状态集合仍是 `["succeeded"]`，run 行在两次打开之间字节一致。
- **重复启动不重复迁移**：第二次打开台账仍是 3 条，没有新增写入。
- 完整性诊断 `integrity: ok`。

补充证据（离线校验）：`tests/integration/reliability.test.ts` 的
“v1 旧数据迁移”用例覆盖 `executionGeneration=1`、`lastHeartbeatAt=旧 updatedAt`、不设租约、
步骤补 `verify_before_retry`、重建 run_index。
