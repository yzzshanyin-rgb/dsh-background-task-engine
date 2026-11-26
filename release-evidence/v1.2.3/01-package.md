# 01 Package completeness (B-02 / B-04)

命令：`node /tmp/pack-check.mjs`（在仓库根执行，`npm pack --dry-run --json`）

```
files: 73 | size: 170203 bytes | unpacked: 569003
missing: none
forbidden present: none
```

必含项（手册表 9）：dist/index.js、client/client.js、cordis.patch.yml、icon.svg、
assets/icon-180.png、assets/preview-1280.png、screenshots.json、README.md、README.en.md、
CHANGELOG.md、LICENSE、locale/{en,zh}.json、docs/DETAIL.md — **全部存在**。
禁止项：tests/、src/、dist 之外的 .ts 源码、release-evidence/ — **均未进入 tarball**。

干净克隆 /tmp/verify-123（`npm ci` → `npm run build` → `npm pack`）：

```
34f48ed8cc894fda9ee7cadec81f2a2e6cdb48e9083ecea559c6d3365e341321  dsh-background-task-engine-1.2.3.tgz
72 files
```

版本一致性：package.json = package-lock.json 根包 = 1.2.3。
