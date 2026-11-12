# openchamber-shardx-workspace

ShardX 指纹浏览器 × OpenChamber 多会话工作台：浏览器标签页式 UI，每个 OpenChamber 会话独占一个指纹实例，互不串线。

## 文件结构

```
openchamber-shardx-workspace/
├── package.json            # 真正的运行时清单（openchamber.contributes）
├── manifest.json           # MCP 工具目录（name/description/inputSchema）
├── index.js                # MCP stdio 服务端：6 个会话隔离工具的真正实现
├── icon.svg
├── panel/
│   ├── index.html          # 面板入口（package.json -> panel/index.html -> panel/main.js）
│   ├── main.ts             # 宿主握手、transport 初始化、自动探测
│   ├── transport.ts        # ServiceTransport：host.serviceRequest 封装
│   ├── api.ts              # ShardXApiClient：ShardX REST + Bearer + discover
│   ├── cdp.ts              # CdpMultiplexer：CDP 命令多路复用（socket 在 service 里）
│   ├── router.ts           # SessionIsolationRouter：会话 <-> profile 独占锁
│   ├── bridge.ts           # OpenChamberBridge：面板侧的工具实现（UI 内）
│   ├── ui.ts               # ShardXTabWorkspaceUI：标签页工作台
│   ├── types.ts / util.ts / style.css
│   └── README.md
└── service/
    ├── ws.ts               # 手写 RFC6455 客户端（零依赖）
    ├── main.ts             # 回环 HTTP 桥接服务（/health /shardx/discover /proxy /cdp/*）
    └── main.js             # bun 打包产物（package.json 的 service.entry）
```

## 自动发现（不用手填端口和 Token）

`service/main.ts` 的 `/shardx/discover` 读取本机
`%APPDATA%\shardx-launcher\settings.json`，取 `api_port` / `api_secret`，
并用 `api_secret` 现场签一个 HS256 JWT（`sub=shardx-api`）作为 Bearer。
ShardX 2.1.x 的鉴权就是这样实现的，所以不需要安装路径，也不需要用户从界面复制 Token。

- 面板首次加载且本地没有 Token 时，会自动调用一次 discover 并静默保存
- 设置弹窗里有「自动检测」按钮，可随时重新读取
- 手动填写的 Token 优先，不会被自动检测覆盖
- 环境变量 `SHARDX_LAUNCHER_SETTINGS` 可以覆盖 settings.json 的位置

## Agent 工具（MCP）

`contributes.tools` 只负责聊天里的展示样式，**不会注册任何工具**。可调用的工具来自
`index.js`（stdio MCP 服务端），需要在 OpenCode 全局配置里注册：

```json
{
  "mcp": {
    "servers": {
      "shardx-workspace": {
        "type": "local",
        "enabled": true,
        "command": [
          "C:\\Users\\<你>\\.local\\tools\\node\\node.exe",
          "C:\\Users\\<你>\\.config\\openchamber\\extensions\\shardx-workspace\\index.js"
        ]
      }
    }
  }
}
```

注册后工具名形如 `shardx-workspace_list_and_bind_profile`，能力与面板一致：
`session_id` 相同的调用共享一个实例，不同 `session_id` 各自独占不同 profile。

| 工具 | 作用 |
|---|---|
| `list_and_bind_profile` | list / bind / auto-bind，profile 独占锁 |
| `session_navigate` | 导航并等待 load / domcontentloaded / networkidle |
| `session_interact` | click / type / scroll / evaluate_js |
| `session_extract_dom` | markdown / html / text / forms |
| `session_manage_cookies` | get / set / clear（CDP Storage / Network） |
| `session_stop_and_release` | 关掉实例并释放锁 |

Node 需要 ≥ 22（全局 `WebSocket`）；`index.js` 零依赖，不装 `ws`/`playwright`。


## 为什么需要本地桥接服务

面板 iframe 的 CSP 只允许访问 guest 文件源，而清单里的 `origins` 只接受 https，
`http://127.0.0.1:40325` 无法被声明成可直连的来源。于是：

```
面板 (iframe) --host.serviceRequest--> service/main.js (127.0.0.1:<宿主分配端口>)
                                             |-- fetch --> ShardX HTTP API
                                             '-- WebSocket --> 指纹实例 CDP
```

宿主启动 service 时注入 `OPENCHAMBER_SERVICE_PORT` 和 `OPENCHAMBER_SERVICE_TOKEN`，
每条路由（含 `/health`）都校验 `Authorization: Bearer <token>`。面板不直接碰网络。

## 核心模块

### ServiceTransport (panel/transport.ts)
- 把 `{method, path, body}` 交给 `host.serviceRequest`
- 非 2xx 转成 `TransportError`（`NO_SERVICE` 会提示去开启 service 能力）
- 单例 `transport`，`main.ts` 在 boot 前 `setHost(host)`

### 桥接服务 (service/main.ts)
| 路由 | 作用 |
|---|---|
| `GET /health` | 宿主就绪探测 |
| `POST /shardx/discover` | 读本机 ShardX settings.json，返回端口 + 现场签发的 Bearer |
| `POST /proxy` | 代理 ShardX REST；只允许回环 `baseUrl`，15s 超时，7MB 上限 |
| `POST /cdp/open` | 建立 CDP WebSocket，返回 `sessionId` |
| `POST /cdp/send` | 写入一帧 CDP 命令（响应作为事件回传） |
| `POST /cdp/events` | 长轮询取回响应与事件（waitMs ≤ 5s） |
| `POST /cdp/close` | 关闭连接 |

事件上限 4000 条 / 4MB，超过丢最旧并置 `gap`；120s 无轮询自动回收。

### CdpMultiplexer (panel/cdp.ts)
- `connect(url, timeoutMs, headers)` -> `/cdp/open`
- `send(method, params, sessionId?, timeoutMs)`：单调 id + Promise 池
- 后台循环 `/cdp/events`：`id` 消息结算 Promise，`method` 消息派发给 `on` / `onAny`
- 连续 4 次轮询失败或服务返回 `NO_SESSION` 才判定连接关闭

### ShardXApiClient (panel/api.ts)
- `profiles()` / `profile(id)` / `startProfile(id)` / `stopProfile(id)` / `proxies()` / `fingerprintTemplate()`
- 端口与 Bearer Token 存在 `host.storage`（scope `instance`）
- `authHeaders()` 把同一个 token 传给 CDP 握手

### SessionIsolationRouter (panel/router.ts)
- `sessionId <-> profileId` 强绑定；一个 profile 同时只能被一个会话锁定
- 每个会话独立的 `CdpMultiplexer`、target 列表、活动 CDP session
- `bindSession` / `attachCdp` / `patch` / `unbindSession` / `clearAll`

### ShardXTabWorkspaceUI (panel/ui.ts)
- 顶部：浏览器式标签栏。固定 `环境` 标签 + 每个实例一条标签（代理颜色点、名称、× 关闭）；
  右侧 `+` 新建实例、`⚙` API 设置
- 控制台：统计/过滤条 + 三种显示方式（卡片 / 列表 / 分组，选择记在 localStorage）；
  卡片与列表都有会话选择、`启动实例` / `打开实例`、停止并释放
- 实例：浏览器外壳（后退/前进/刷新、地址胶囊、截图、Cookie、详情抽屉、会话锁、释放）、
  `Target.getTargets` 子标签页、`Page.captureScreenshot` 轮询视口（约 1.3s）、
  点击/键盘转发、检查器（会话/指纹/页面）与 CDP 日志、底部状态栏

## 多会话并行指南

1. 在 OpenChamber 里开多个会话，每个会话打开一次 ShardX Workspace 面板。
2. 绑定：控制台点 `[🔗 绑定到当前会话并启动]`，或调用
   `shardx_list_and_bind_profile(session_id, 'bind', profileId)` /
   `shardx_list_and_bind_profile(session_id, 'auto-bind')`。
3. 操作：`shardx_session_navigate(session_id, url)`、
   `shardx_session_interact(session_id, 'click', selector)`、
   `shardx_session_interact(session_id, 'type', selector, text)`、
   `shardx_session_extract_dom(session_id)`、
   `shardx_session_manage_cookies(session_id, 'get'|'set'|'clear')`。
4. 结束：`shardx_session_stop_and_release(session_id)` 关闭实例并释放独占锁。

特性：N 个会话 = N 条独立 CDP 管道；Cookie/DOM 上下文互不污染；独占锁阻止两个会话抢同一实例；
同一会话内多个标签页共享一条 CDP 连接、按 target sessionId 分流。

Cookie 走 `Storage.*`（浏览器级），兼容已移除 `Network.getAllCookies` 的新版 Chromium。

## 技术约束

- ✅ 零第三方运行时依赖：面板只用原生 `fetch`（SDK 内部）与 `host.serviceRequest`；
  服务只用 Node 内置模块 + 手写 RFC6455 客户端，不引入 `ws`
- ✅ 构建：`bun run build:panel` / `bun run build:service`
- ✅ 类型检查：`tsc --noEmit` 通过
- ✅ 端到端验证：真实 Chrome CDP（导航、事件、截图、Cookie）全部通过
