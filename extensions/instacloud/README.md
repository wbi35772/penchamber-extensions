# InstaCloud for OpenChamber

在 OpenChamber 侧边栏里管理 InstaCloud：项目、Compute / 数据库 / Redis / 对象存储、镜像与 GitHub 部署、日志、指标、容器命令和分支。

不依赖 `insta` CLI，不需要 SSH 密钥或 `~/.ssh/config`。只需要一个**组织作用域**的 InstaCloud API 令牌（`insta_...`）。

## 功能

- **项目**：切换组织、列出 / 创建 / 删除项目，自动记住上次打开的组织和项目。
- **服务**：创建 compute、Postgres、Redis、MySQL、MongoDB、Storage；启动、停止、重启、暂停、删除；状态每 15 秒刷新。
- **部署**：部署 Docker 镜像；从公开 GitHub 仓库构建；查看构建记录并重新触发源构建。
- **日志**：按服务、行数（100–2000）和级别筛选，支持 5 秒自动刷新。
- **指标**：CPU、CPU 核心、内存用量及服务返回的其他时序；粒度 1 / 5 / 15 分钟，20 秒自动刷新。
- **终端**：在 compute 容器内执行一次性 `sh -lc` 命令，保留历史与快捷命令。
- **分支**：创建（可复制当前服务定义或创建空分支）、切换、删除分支。

## 安装

1. 在 OpenChamber 中打开 **设置 → 扩展**，安装 `instacloud-extension-0.1.0.zip`（或选择本目录）。安装后确认授予 **network** 权限。
2. 打开 **设置 → 集成 → InstaCloud**，粘贴组织作用域令牌并保存。令牌由 OpenChamber 保管，扩展页面不会读取或显示它。
3. 点击侧边栏的 **InstaCloud** 图标。首次加载会读取 `/me` 和 `/orgs`，然后列出组织内的项目。

> 新装的扩展面板图标默认排在右侧图标栏的最后，图标多时会被挤到屏幕底部。点击图标栏最下方的 **配置面板**，把 **InstaCloud** 拖到靠上的位置即可；也可以按 `Ctrl+K` 搜索 `InstaCloud` 直接打开（隐藏的面板仍可这样打开）。

也可以在扩展宿主机上直接上传 zip：

```powershell
curl.exe -X POST "http://127.0.0.1:53253/api/guests/upload?replace=true" `
  -H "Content-Type: application/zip" `
  --data-binary "@instacloud-extension-0.1.0.zip"
```

> 如果选择“从文件夹安装”时路径包含中文并返回 `not-found`，请改用 zip 安装，或先把目录复制到纯 ASCII 路径。

### 令牌要求

- 以 `insta_` 开头的组织令牌，至少能访问目标组织的项目和 compute 服务。
- 令牌存在 OpenChamber 的集成凭据存储中；所有请求都由扩展宿主携带令牌发往 `https://api.instacloud.com`。
- 扩展不会把令牌写入面板 DOM、日志或本地存储。

### 可选设置

**设置 → 集成 → InstaCloud** 中可配置：

- **默认区域**：`us-east` / `eu-central` / `ap-southeast`，新建服务时预选。
- **默认组织 ID**：有多组织权限时指定默认组织；留空则使用令牌所属组织。

## 使用说明

- **服务** 页的状态来自服务列表，操作是异步的；启动 / 停止 / 重启后会自动重新拉取状态。
- **部署** 页需要先有一个 compute 服务。镜像部署会滚动更新容器；GitHub 部署由 InstaCloud 远程构建。
- **日志** 和 **指标** 是轮询，不是实时流。指标通常需要服务运行 1–2 分钟后才有第一个采样点。
- **终端** 只支持一次性命令，单次最长 15 秒，不支持交互式 PTY。交互式 SSH 需要人工登录会话，API 令牌无法创建。
- 删除分支、服务或项目会同时删除其数据卷和路由，无法恢复。

## 限制

- 仅支持公开 GitHub 仓库；私有仓库需要安装 GitHub App 后使用官方 CLI。
- REST API 不暴露“上传本地目录”部署，因此部署入口是预构建镜像或公开 GitHub 仓库。
- 日志 / 指标不是 WebSocket 流；面板通过 HTTP 轮询。
- 宿主的单次请求超时约 20 秒，终端被限制在 15 秒以内；生命周期请求超时后会继续轮询，而不是判定失败。

## 开发

```bash
bun install
bun run typecheck
bun run build
```

- `panel/main.ts` → `panel/main.js` 由 `bunx openchamber-guest-bundle` 打包为浏览器 IIFE。
- SDK：`@openchamber/sdk 2.6.0`；要求 OpenChamber `>= 2.5.0`。
- 目录：`panel/views/` 下按功能拆分；样式在 `panel/style.css` 与 `panel/extra.css`。
- 运行 `bun run build` 后重新安装 zip 才会加载新代码。

## 文件

```text
package.json          扩展清单（panel + integration）
icon.svg              侧边栏图标
panel/index.html      面板入口
panel/main.js         构建产物（安装时使用）
panel/style.css       基础样式
panel/extra.css       补充样式
panel/api.ts          InstaCloud REST 客户端
panel/views/          服务 / 部署 / 日志 / 指标 / 终端 / 分支
```
