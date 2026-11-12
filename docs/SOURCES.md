# 来源与快照

快照日期：2026-11-11。每个扩展目录都是源工作树的复制，保留当时的未提交修改和构建产物。

## 源路径映射

| 快照目录 | 源路径 | git 状态 | 上游 | 快照说明 |
|---|---|---|---|---|
| `extensions/instacloud` | `D:\Project\Openchamber\初始配置\projects\instacloud-extension` | 无 git | 无 | 当前目录原样；含 `instacloud-extension-0.1.0.zip` |
| `extensions/obsidian-panel` | `D:\Project\Openchamber\初始配置\projects\obsidian-panel` | `main@a4c7345`，干净 | [openchamber-obsidian-panel](https://github.com/wbi35772/openchamber-obsidian-panel) | 与上游 HEAD 一致 |
| `extensions/instabox-matrix` | `D:\Project\Openchamber\初始配置\projects\openchamber-instabox-matrix` | `main@064528c`，5 项未提交 | [openchamber-instabox-matrix](https://github.com/wbi35772/openchamber-instabox-matrix) | 本地未配置 remote；快照包含 `scripts/keepalive-tick.js` 等工作树改动 |
| `extensions/shardx-workspace` | `D:\Project\Openchamber\初始配置\projects\openchamber-shardx-workspace` | `master@f8db7b0`，18 项未提交 | 无 | 快照包含未提交的 `panel/mirror.ts` 与 6 张 preview PNG；`package.json` 1.2.0 与 `manifest.json` 1.3.0 不一致 |
| `extensions/openwith-matrix` | `D:\Project\Openchamber\初始配置\projects\openwith-matrix` | `main@7251072`，20 项未提交 | [openchamber-openwith-matrix](https://github.com/wbi35772/openchamber-openwith-matrix) | 快照包含生成的 `dist/` 与未提交的 `service/marketplace.ts`、`service/marketplaceZh.ts` |

## 复制规则

排除：

- `node_modules/`
- `.git/`
- `_temp/`、`.turbo/`、`.cache/`
- `*.log`、`*.tmp`、`*.tsbuildinfo`
- `.env`、`.env.*`（五个源目录均未发现）

有意保留：

- `instacloud/instacloud-extension-0.1.0.zip`：可解压为安装目录。
- `openwith-matrix/dist/`：7 个文件的安装包。

## 关联仓库（未纳入）

| 仓库 | 状态 | 为什么不在本合集 |
|---|---|---|
| [wbi35772/proxygate-matrix](https://github.com/wbi35772/proxygate-matrix) | `main@3661517`；132 个跟踪文件；干净克隆 `docker build` 成功，容器 `web=200`、`/api/version=0.1.0-dev` | Go 服务 + React 面板，是 Instabox 的配套网关，不是 OpenChamber 扩展 |
| [wbi35772/o2a](https://github.com/wbi35772/o2a) | `30df6e5` | opencode2api 反代服务，不是扩展 |
| 本地 `warp-handoff/` | 仅文档 | WARP 池运维交接，不可安装 |

`proxygate-matrix` 本地 `.git` 是损坏的 shallow 克隆；需要开发时重新 clone，不要复用。

## 安全检查

- 强特征扫描（`sk-`、`ghp_`、`AKIA`、私钥头、JWT、Bearer）在五个扩展源树中 0 命中。
- 弱命中 535 处，均为 `token`、`maxOutputTokens` 一类变量名。
- 测试夹具使用占位值：`ibk_test`、`admin` / `change-me`、`10.0.0.x`。
- `.env` / 私钥 / `credentials.json`：0 个。
- 内部主机名（`.insta.internal`、`*.instacloud-edge.com`）只存在于 `warp-handoff/`、`o2a-repo/` 等未纳入目录，不在本仓库。

## 重新同步

```powershell
# 校验
powershell -ExecutionPolicy Bypass -File .\scripts\sync-from-local.ps1 -Check

# 覆盖复制
powershell -ExecutionPolicy Bypass -File .\scripts\sync-from-local.ps1
```

脚本从自身位置推导工作区根目录，默认对应 `D:\Project\Openchamber\初始配置\projects`，无需修改路径。
