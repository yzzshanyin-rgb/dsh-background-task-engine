# 07 Docs and market materials (G)

## 手册 §8.1 措辞检查（清理行为）

- ✅ README「清理行为」写成 **「插件启动时执行的分批清理」**，并明确“不是常驻定时器，
  也不是周期性后台任务；长时间不重启的进程里过期记录会保留到下次启动”。
- ✅ 英文版对应 “batched prune performed at plugin startup … not a resident timer and not a
  periodic background job”。
- ✅ CHANGELOG 1.2.3 未出现“定期自动清理”表述。

## 手册 §8.2 市场文案必须说明的五点

| 要求 | 落在哪里 |
|---|---|
| 解决什么问题、步骤由调用方 Agent 执行而非常驻 Worker | README 首段 + 「执行协议」；市场 description.zh |
| 支持的 DSH/Node 范围与实际验证版本 | README「支持范围」表（声明 vs 实测分列）；package.json `engines` |
| 定时依赖 DSH 原生 Schedule | README「定时」小节 + 「支持范围」表 + 1.2.3 的 `TASK_SCHEDULE_UNAVAILABLE` 行为 |
| Session 隔离适用的部署模型 | README「部署模型与已知边界」；面板提示；`/status` 字段 |
| 1.1.x → 1.2.x 迁移行为与备份建议 | README「升级」+ 回滚注记；CHANGELOG「Migration」段 |

## 一致性核对（脚本输出）

```
README.zh: {'14 个工具': True, 'schema 版本 2': True, '部署模型与已知边界': True,
            '插件启动时执行的分批清理': True, '升级前请备份': True,
            'engines.dsh: >=0.2.2-rc.3': True}
README.en: {'Deployment model and known boundary': True,
            'batched prune performed at plugin startup': True,
            '**Back up**': True, 'engines.dsh: >=0.2.2-rc.3': True}
CHANGELOG: {'## [1.2.3]': True, 'TASK_SCHEDULE_UNAVAILABLE': True,
            'assets/preview-1280.png': True}
package: 1.2.3 {'node': '>=22', 'dsh': '>=0.2.2-rc.3'}
```

## 市场条目

`dsh-background-task-engine-market/data/plugins/yzzshanyin-rgb__dsh-background-task-engine.yml`
已存在且符合 contributing.md：category `tools`、icon 为 GitHub 托管的位图 PNG、
description.en 单行以句号结尾、无注释与 `npm:` 字段、文件名 slug 与 url 一致。
本版本把图标补进 npm 包（`assets/icon-180.png`），使 README 与市场详情页都能引用同一个文件。
