# 09 Post-publish verification

## Registry

```console
$ npm view dsh-background-task-engine version engines dependencies peerDependencies
1.2.4
{ node: '>=22', dsh: '>=0.2.2-rc.3' }
{ zod: '^3.25.76' }
{ '@deepseek-ai/schemastery': '^3.18.5' }

publish shasum: f2c45e9cc243aff326683b7c920604b660ac7605
publish total files: 73, unpacked size: 578.7 kB
```

`dist-tags.latest` 在发布后约 80 秒收敛到 `1.2.4`，tarball 可下载。

## Clean install

在空目录 `npm install dsh-background-task-engine@1.2.4`：

```console
installed version: 1.2.4
engines: {"node":">=22","dsh":">=0.2.2-rc.3"}
files present: dist/index.js=true client/client.js=true cordis.patch.yml=true
               assets/icon-180.png=true assets/preview-1280.png=true
               screenshots.json=true locale/en.json=true locale/zh.json=true
default export: function | name: dsh-background-task-engine
inject: ["tools","storageDomain"]
```

## Profile install

```console
remove_bundle dsh-background-task-engine        → application: applied
install_bundle dsh-background-task-engine@1.2.4 → application: applied, warnings: []
profile node_modules/dsh-background-task-engine → 1.2.4
```

## Live host

安装后引擎重新初始化（`lastRecoveryScanAt` 刷新到 `2026-11-27T09:20:08Z`）。

```console
GET /dsh-background-task/api/status?session=<uuid>
{"success":true,"storageAvailable":true,"scheduleAvailable":true,
 "activeRunCount":0,"blockedRunCount":0,"interruptedRunCount":0,
 "integrityStatus":"ok","unsettledScheduleOps":0,
 "deploymentModel":"local-single-user","sessionVerified":false}

GET /dsh-background-task/api/tasks?session=a
400 {"success":false,"error":{"code":"TASK_INVALID_ARGUMENTS",
     "message":"会话标识格式不合法：只接受宿主生成的字母数字标识"}}

数据文件 ~/.dsh/storages/dsh_background_task_engine.json
unit version 2 | 8 tables | tasks 1 | task_runs 3 | task_run_steps 9
```

数据在升级中保持完整，未出现运行状态被改写。
