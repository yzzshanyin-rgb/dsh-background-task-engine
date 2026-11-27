# 02 Build & Tests

执行于仓库工作区，Node v24.13.0。

```console
$ npx tsc --noEmit
(无输出，退出码 0)

$ npm run build
> dsh-background-task-engine@1.2.4 build
> tsc -p tsconfig.json
(退出码 0)

$ npx vitest run
 ✓ tests/domain/state.test.ts (22 tests)
 ✓ tests/integration/client-bundle.test.ts (17 tests)
 ✓ tests/storage/repository.test.ts (18 tests)
 ✓ tests/services/schedule-time.test.ts (13 tests)
 ✓ tests/integration/http-routes.test.ts (10 tests)
 ✓ tests/tools/render.test.ts (13 tests)
 ✓ tests/integration/reliability.test.ts (20 tests)
 ✓ tests/integration/tools.test.ts (35 tests)
 ✓ tests/domain/config.test.ts (7 tests)

 Test Files  9 passed (9)
      Tests  155 passed (155)
```

`dist/` 由 `tsc` 从 `src/` 重新生成，未手改。

## 与 1.2.3 的差异

reliability 由 14 项增至 20 项，新增用例覆盖：

| 用例 | 断言的行为 |
|---|---|
| 跨任务并发上限 | 同会话对不同任务并发 `task_run`，仍受 `maxActiveRunsPerOwner` 约束 |
| 重叠请求只建一条宿主规则 | 并发 `task_schedule(create)` 不会在宿主留下两条规则 |
| 本地写失败后的对账 | 宿主已建规则、本地写失败 → 台账 `failed`，对账采纳并补 `scheduleRef` |
| 删除需两侧落地 | 宿主删除成功但本地未清引用时不算 `succeeded` |
| 历史按真实状态过滤 | 索引行陈旧时以运行记录状态为准 |
| 最近五次运行 / 畸形游标 | 同毫秒按 `runId` 兜底排序；坏游标按第一页处理 |
