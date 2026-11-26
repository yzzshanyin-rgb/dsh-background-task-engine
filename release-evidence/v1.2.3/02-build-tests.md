# 02 Build and tests (B-03)

干净克隆 /tmp/verify-123，先 `npm ci`（无 node_modules 复用）：

```
> tsc -p tsconfig.json
> tsc -p tsconfig.json --noEmit

Test Files  9 passed (9)
     Tests  149 passed (149)
```

套件分布：state 22 / repository 17 / config 7 / schedule-time 13 / render 13 / tools 33 /
reliability 14 / http-routes 10 / client-bundle 17（= 146 + 3；以 `vitest run` 输出 149 为准）。

覆盖的验收项见 `docs/TEST-REPORT.md` 的 V1.2.0 acceptance matrix 与本轮新增的
SEC-05（畸形 session 400）与“部署模型显式化”两项。
