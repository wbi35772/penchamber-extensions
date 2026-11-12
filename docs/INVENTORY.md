# 扩展清单

所有扩展均使用 `openchamber.apiVersion: 1`。安装目标目录为 `%USERPROFILE%\.config\openchamber\extensions\<id>`。

## instacloud

| 项 | 值 |
|---|---|
| 包名 / 版本 | `openchamber-instacloud` / 0.1.0 |
| 许可 | MIT |
| manifest | `package.json` → `openchamber.contributes` |
| 入口 | `panel/index.html`（panel id `instacloud`） |
| 集成 | `integration.token.apiOrigin = https://api.instacloud.com`，`/me`，字段 `user.email`，Bearer |
| 设置项 | `default-region`、`default-org` |
| 依赖 | dev：`@openchamber/sdk 2.6.0`、`typescript ^5.6.3` |
| 构建 | `bun run build` → `bunx openchamber-guest-bundle panel/main.ts panel/main.js` |
| 引擎 | `openchamber >= 2.5.0` |
| 快照 | 22 文件 / 0.33 MB；含 `instacloud-extension-0.1.0.zip`；无 git |

注意：当前源码只有 `panel/`，会话 #2 讨论的本地 `service/` 尚未落地，实际 manifest 只声明 panel + integration。

## obsidian-panel

| 项 | 值 |
|---|---|
| 包名 / 版本 | `obsidian-panel` / 0.1.0 |
| 许可 | 未声明 |
| 入口 | `panel/index.html`（panel id `obsidian-panel`，名称 “Brain + Obsidian”） |
| 页面 | `brain/index.html`，标题 `Brain` |
| 状态区 | `brain/section.html`，标题 `Brain 任务`，高度 320，默认展开 |
| 服务 | `service/main.js`，`runtime: host`；exec 允许：`Obsidian.exe`、`powershell.exe`、`tasklist.exe` |
| capabilities | `sessions`、`prompt` |
| 依赖 | `@openchamber/sdk 2.6.0`、`esbuild 0.28.0`、`ws 8.18.3` |
| 构建 | `node scripts/build.mjs` |
| 引擎 | `openchamber >= 2.0.1` |
| 快照 | 29 文件 / 0.87 MB；git `main@a4c7345`，工作树干净 |

## instabox-matrix

| 项 | 值 |
|---|---|
| 包名 / 版本 | `openchamber-instabox-matrix` / 1.4.0 |
| 许可 | MIT |
| 入口 | `panel/index.html`（panel id `instabox-matrix`） |
| 服务 | `service/main.js`，`runtime: host` |
| 工具 | `match: mcp.instabox-matrix.*`，输出 markdown |
| 依赖 | 无运行时 npm 依赖；零构建原生 ES Module |
| 测试 | `node --test`（`tests/`） |
| 引擎 | `openchamber >= 2.5.0` |
| 快照 | 38 文件 / 0.70 MB；git `main@064528c` + 未提交 `scripts/keepalive-tick.js` 等改动 |

## shardx-workspace

| 项 | 值 |
|---|---|
| 包名 / 版本 | `openchamber-shardx-workspace` / 1.2.0 |
| MCP manifest | `manifest.json` / **1.3.0**（与 package 版本不一致，原样保留） |
| 许可 | MIT |
| 入口 | `panel/index.html`（panel id `shardx-workspace`） |
| 服务 | `service/main.js`，`runtime: host` |
| 工具 | 6 项，`match: mcp.shardx*`：列表/绑定、打开网页、页面交互、提取内容、Cookie、关闭释放 |
| 依赖 | dev：`@openchamber/sdk 2.6.0`、`typescript ^5.6.3` |
| 构建 | `bun run build`（panel + service） |
| 引擎 | `openchamber >= 2.5.0` |
| 快照 | 68 文件 / 3.73 MB；git `master@f8db7b0` + 未提交 `panel/mirror.ts`、6 张 preview PNG |

## openwith-matrix

| 项 | 值 |
|---|---|
| 包名 / 版本 | `openchamber-openwith-matrix` / 2.0.0 |
| 许可 | Apache-2.0 |
| 入口 | `panel/index.html`（panel id `openwith`） |
| 页面 | `contributes.page: true` |
| 服务 | `service/main.js`，`runtime: host`；exec 允许列表见 `package.json`（open/xdg-open/cmd/powershell/wsl/bash/git/docker/kubectl/code/cursor/zed/…） |
| capabilities | `sessions`、`prompt`、`files`、`model` |
| 文件系统 | `~/**`、`/.git/**`、`/workspace/**` |
| 依赖 | dev：`@openchamber/sdk ^2.6.0`、`@types/node ^24.0.0`、`typescript ^5.9.0` |
| 构建 | `node scripts/build.mjs`；`typecheck`；`test` |
| 引擎 | `openchamber >= 2.0.0` |
| 快照 | 61 文件 / 0.93 MB（含 `dist/`）；git `main@7251072` + 未提交 `service/marketplace.ts`、`service/marketplaceZh.ts` |

安装包是 `dist/`（7 个文件：`package.json`、`icon.svg`、`config/default-matrix.json`、`panel/index.html`、`panel/main.js`、`panel/styles.css`、`service/main.js`）。

## 与已安装副本的关系

已安装目录：`%USERPROFILE%\.config\openchamber\extensions`。

| 扩展 | 已安装版本 | 文件数 | 与源快照的差异 |
|---|---|---|---|
| `instabox-matrix` | 1.4.0 | 22 | `lib/leases.js` 不同；已安装版多 `panel/index.html.diagbak` |
| `instacloud` | 0.1.0 | 7 | `README.md` 不同 |
| `obsidian-panel` | 0.1.0 | 9 | 无差异 |
| `openwith` | 2.0.0 | 7 | 无差异（对应源 `dist/`） |
| `shardx-workspace` | 1.2.0 | 65 | 无差异；源目录多 `tsconfig.json`、`validate-manifest.mjs` |

本合集记录的是**源目录工作树**，不是已安装副本的镜像。
