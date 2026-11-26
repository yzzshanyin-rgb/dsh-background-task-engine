# 02 Build and tests (B-03)

干净克隆 /tmp/verify-123，先 `npm ci`（无 node_modules 复用）：

```
> tsc -p tsconfig.json
> tsc -p tsconfig.json --noEmit

Test Files  9 passed (9)
     Tests  149 passed (149)
```

套件分布（`vitest run --reporter=json` 实测）：config 7 / state 22 / schedule-time 13 /
client-bundle 17 / http-routes 10 / reliability 14 / tools 35 / render 13 / repository 18 = **149**。

覆盖的验收项见 `docs/TEST-REPORT.md` 的 V1.2.0 acceptance matrix 与本轮新增的
SEC-05（畸形 session 400）与“部署模型显式化”两项。
