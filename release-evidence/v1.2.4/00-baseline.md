# 00 Baseline

| 项 | 值 |
|---|---|
| 日期 | 2026-11-27 |
| 分支 | main |
| 版本基线 | 1.2.3（修复后升 1.2.4） |
| 本次 commit | `2d2345cf49a742acd6a6586dbbb760ba5b5529f5` |
| Tag | v1.2.4 |
| Node | v24.13.0 |
| npm | 11.6.2 |
| DSH | 0.2.2-rc.3（Desktop，/Applications/DeepSeek Harness.app） |
| tarball | `dsh-background-task-engine-1.2.4.tgz`（73 个文件，172788 字节） |
| 包 SHA256 | `a85bb68b47b1e0a23ba7a87d1fbf99d5ea4682690922b2f0ea7eec273bf58aaf` |

改动范围：并发锁（owner 级）、定时台账临界区与对账、回滚顺序、索引刷新、分页排序与游标。
不含存储模型变更，schema 仍为 v2，无需迁移。
