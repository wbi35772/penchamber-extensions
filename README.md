# Penchamber Extensions

OpenChamber（penchamber）二次开发扩展的合集与备份快照。每个扩展保留独立目录，按原始工作树原样归档，便于后续恢复、对比和继续开发。

- 快照日期：2026-11-11
- 扩展数量：5
- 快照文件：218 个，约 6.6 MB
- 归档策略：源码 + 当前构建产物原样复制；排除 `node_modules/`、`.git/`、日志、临时文件与 `.env`
- 来源、git 状态与未提交改动：见 [`docs/SOURCES.md`](docs/SOURCES.md) 和每个目录下的 `SOURCE.json`

## 扩展一览

| 目录 | 包名 | 版本 | 贡献点 | 入口 | 文件 | 体积 | 上游 |
|---|---|---|---|---|---|---|---|
| [`extensions/instacloud`](extensions/instacloud) | `openchamber-instacloud` | 0.1.0 | panel + integration | `panel/index.html` | 22 | 0.33 MB | 无公开仓库 |
| [`extensions/obsidian-panel`](extensions/obsidian-panel) | `obsidian-panel` | 0.1.0 | panel + page + statusSection + service | `panel/index.html` | 29 | 0.87 MB | [openchamber-obsidian-panel](https://github.com/wbi35772/openchamber-obsidian-panel) |
| [`extensions/instabox-matrix`](extensions/instabox-matrix) | `openchamber-instabox-matrix` | 1.4.0 | panel + service + tools | `panel/index.html` | 38 | 0.70 MB | [openchamber-instabox-matrix](https://github.com/wbi35772/openchamber-instabox-matrix) |
| [`extensions/shardx-workspace`](extensions/shardx-workspace) | `openchamber-shardx-workspace` | 1.2.0 | panel + service + tools | `panel/index.html` | 68 | 3.73 MB | 无公开仓库 |
| [`extensions/openwith-matrix`](extensions/openwith-matrix) | `openchamber-openwith-matrix` | 2.0.0 | panel + page + service | `panel/index.html` | 61 | 0.93 MB | [openchamber-openwith-matrix](https://github.com/wbi35772/openchamber-openwith-matrix) |

## 安装

文件夹扩展统一放到：

```text
%USERPROFILE%\.config\openchamber\extensions\<扩展 id>
```

按目录复制后重启 OpenChamber：

```powershell
$dest = "$HOME\.config\openchamber\extensions"

Copy-Item -Recurse -Force .\extensions\instacloud          "$dest\instacloud"
Copy-Item -Recurse -Force .\extensions\obsidian-panel      "$dest\obsidian-panel"
Copy-Item -Recurse -Force .\extensions\instabox-matrix     "$dest\instabox-matrix"
Copy-Item -Recurse -Force .\extensions\shardx-workspace    "$dest\shardx-workspace"
Copy-Item -Recurse -Force .\extensions\openwith-matrix\dist "$dest\openwith"
```

说明：

- `instacloud` 也可以解压 `instacloud-extension-0.1.0.zip` 得到同样的安装目录。
- `openwith-matrix` 的安装包是 `dist/`，不是仓库根目录。
- 带 `service` 的扩展首次使用时会请求宿主授权 `exec` 命令；`openwith` 与 `obsidian-panel` 的允许列表见各自 `package.json`。

## 目录结构

```text
penchamber-extensions/
├─ extensions/
│  ├─ instacloud/          # panel + integration
│  ├─ obsidian-panel/      # Brain 任务板 + Obsidian 窗口
│  ├─ instabox-matrix/     # 多账号 Instabox 矩阵 + MCP 工具
│  ├─ shardx-workspace/    # ShardX 指纹浏览器工作区
│  └─ openwith-matrix/     # 多标签工作区 + 访客扩展宿主桥
├─ docs/
│  ├─ SESSIONS.md          # 14 个开发会话的整理与映射
│  ├─ INVENTORY.md         # 扩展清单、manifest、依赖与权限
│  └─ SOURCES.md           # 来源路径、git 状态、未提交改动与关联仓库
├─ scripts/
│  └─ sync-from-local.ps1  # 从本地工作区重新同步 / 校验快照
└─ SOURCE.json             # 每个扩展目录内各一份
```

## 同步与校验

```powershell
# 校验当前快照与本地工作区是否一致
powershell -ExecutionPolicy Bypass -File .\scripts\sync-from-local.ps1 -Check

# 重新复制
powershell -ExecutionPolicy Bypass -File .\scripts\sync-from-local.ps1
```

## 关联但未纳入的仓库

这些是配套服务/基础设施，不属于 OpenChamber 扩展，单独维护：

- [`wbi35772/proxygate-matrix`](https://github.com/wbi35772/proxygate-matrix)：Go 服务 + React 面板，Instabox 的配套代理网关；`main` 已验证到 `3661517`，干净克隆可 `docker build`。
- [`wbi35772/o2a`](https://github.com/wbi35772/o2a)：opencode2api 反代服务，`30df6e5`。
- `warp-handoff/`：WARP 池运维文档，仅存在于本地工作区，不是可安装扩展。

## 备注

会话整理见 [`docs/SESSIONS.md`](docs/SESSIONS.md)。`shardx-workspace` 的 `package.json` 是 `1.2.0`，其 MCP `manifest.json` 是 `1.3.0`，两者不一致，快照保持原样未改。
