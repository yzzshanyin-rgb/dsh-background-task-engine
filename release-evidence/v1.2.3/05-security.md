# 05 Security: board routes and Session boundary (E)

## 宿主的实际机制（实测 asar）

- `ctx.webServer` 的 Config schema 拒绝绑定通配地址，报错原文含
  “binding every interface would expose remote code execution to the network; bind one concrete
  IPv4 or IPv6 address of a local interface instead”。因此 Web GUI 默认只在本机回环上监听。
- `WebRoute` 的 handler 签名是 `handler(req: IncomingMessage, res: ServerResponse)`：
  **静态路由没有 per-request 身份参数**。认证层（`dsh-api-remote-access` 的 `decide()`）
  覆盖的是 RPC 网关，不覆盖插件注册的 exact 路由。

## 逐条结论

| 用例 | 要求 | 本插件现状 | 结论 |
|---|---|---|---|
| SEC-01 | 匿名请求被拒绝 | 路由对每个请求强制 `session` 参数，缺失返回 403 `TASK_PERMISSION_DENIED`；但“匿名”在这里等价于“本机任意进程” | 部分（宿主无认证可挂） |
| SEC-02 | 只见自己的数据 | 服务端按传入 session 过滤 `ownerSessionId`，列表/详情/运行/操作全部按该 session 校验 | 通过（在被信任的 session 选择器前提下） |
| SEC-03 | 改 session 参数不能读他人 | **不成立**：宿主要求的“Peer 与 Session 的可信绑定”不存在，任何本机进程都可构造相同请求 | 设计限制，已在 README/面板声明 |
| SEC-04 | 用他人 taskId/runId 返回拒绝或 404 | 跨 session 取任务返回 404 `TASK_NOT_FOUND`（与不存在同形，不能探测） | 通过（测试覆盖） |
| SEC-05 | 缺失/空/短/畸形 session 被参数校验拒绝 | 新增 `SESSION_ID_PATTERN`（长度 6–128、字符集 `A-Za-z0-9._-`、拒绝路径穿越样式），畸形返回 400 `TASK_INVALID_ARGUMENTS` | 通过（新增 2 项测试） |
| SEC-06 | 不信任请求体里的 owner/session | 所有写操作只接受 `session` 选择器与 `taskId/runId`，owner 一律从该 session 推出；请求体里的 owner 字段被忽略 | 通过 |

工具层不受上述限制：`task_*` 的会话来自 `exec.agent.session.id`（宿主注入），无法由模型伪造；
跨 session 的记录一律 `TASK_NOT_FOUND`。

## 因此的对外承诺

- **不宣称支持多人共享或公网部署。** `/status` 返回 `deploymentModel: 'local-single-user'`
  与 `sessionVerified: false`；面板底部有同样意思的提示；README 中英双语各有一节说明。
- 若宿主将来为静态路由提供可信 Peer 身份，看板应改为从 Peer 推导 session，而不是采信 query。

## 证据

- `tests/integration/http-routes.test.ts`（10 项）：路由集合、按 session 过滤、缺 session 403、
  畸形 session 400、跨 session 404、时间线不含执行凭证、操作走 service 且 revision 递增、
  非 POST 与未知 action 400、`/status` 按 caller 计数、部署模型字段。
- `tests/integration/tools.test.ts`：跨 session `TASK_NOT_FOUND`、伪造执行凭证
  `TASK_RUN_INTERRUPTED`。
