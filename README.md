# pbmockx

[![npm version](https://img.shields.io/npm/v/pbmockx.svg?label=npm&logo=npm)](https://www.npmjs.com/package/pbmockx)
[![node](https://img.shields.io/node/v/pbmockx.svg?label=node&logo=node.js)](https://www.npmjs.com/package/pbmockx)
[![license](https://img.shields.io/npm/l/pbmockx.svg?label=license)](LICENSE)

[English](README.en.md) · 中文

**自带抓包、Mock 与 Web UI 的 protobuf / JSON 调试工具** —— 不再依赖 whistle。

pbmockx 在本机启动一个 HTTP/HTTPS 代理，自动识别 Charles 风格的自描述 protobuf
（`Content-Type: application/x-protobuf; desc="..."; messageType="..."`）与 JSON，
把响应展示成带类型标注的字段树，并支持按 path 直接改字段。**PB 全程不转 JSON**，
避免 int64→string、enum→string 的歧义；同时为人和 AI agent 各提供一套顺手的界面。

```
客户端 / Android / curl ──proxy──► pbmockx (:8899)
                                    ├─ 抓包（HTTP / HTTPS MITM / WebSocket / SSE）
                                    ├─ Mock（patch / map_local / map_remote）
                                    ├─ 控制 API（CLI 使用）
                                    └─ Web UI（实时 flow / 字段树 / 规则编辑）
```

## 能力

- **抓包**：HTTP 正向代理、HTTPS CONNECT 中间人（自带 CA）、gzip/deflate/br、SSE 流式透传、WebSocket 隧道、大 body 背压转发。
- **PB 字段树**：`name#N (type) = value`，带字段号/类型；enum 显示数字 + 名字，bytes 显示 base64 + 字节数，`google.protobuf.Any` 按 `type_url` 自动展开；未设置字段显示 `(unset)`。
- **统一 Mock**（PB 与 JSON 行为一致）：
  - `patch`：按 path 改字段，支持 repeated 的 `--append/--insert/--remove`、删除字段 `--unset`，path 可穿透 `Any`。
  - `map_local`：整 body 替换（`--data` JSON 自动编码为 PB，或 `--file` 直接返回本地字节），支持状态码/响应头覆盖。
  - `map_remote`：请求重定向（整体替换或 regex），可把线上接口指到本地 mock server。
- **Web UI**：实时 flow 列表、请求/响应详情、交互式字段树、mock 前后对比、规则 CRUD/启停、mock 数据编辑、CA 下载与分平台接入指引。
- **AI agent 友好**：CLI 默认折叠输出节省 token；`--path` 钻取子树；所有读命令支持 `--json`；SKILL.md 可直接注入 agent。
- **零 whistle 依赖**：运行时只有 `protobufjs`、`long`、`js-yaml`、`node-forge` 四个依赖。

## 安装

环境：Node.js ≥ 18（macOS / Linux 已验证；Windows 未实测）。

### npm（推荐）

包内已带编译好的 `dist/`，装完即可用，不需要 TypeScript：

```bash
npm i -g pbmockx          # 全局命令 pbmockx / pbmockxd
pbmockx start

npx pbmockx@latest start  # 不想全局安装时
```

升级：`npm i -g pbmockx@latest && pbmockx restart`。卸载：`npm rm -g pbmockx`（数据目录 `~/.pbmockx` 需手动删除）。

### 安装脚本（从源码）

```bash
# 远程一行（main）
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"

# 或本地仓库
./scripts/install.sh

# 安装指定分支/版本
PBMOCKX_REF=<branch-or-tag> \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
```

安装脚本会：检查 Node → `npm install` + `tsc` → `npm link`（提供全局 `pbmockx` 命令，替换旧的 whistle 全局链接）→ 安装 agent skill → `pbmockx restart` 启动并验证。

- 代码安装到 `~/.pbmockx/app`，数据（规则、mock、CA、日志）在 `~/.pbmockx`；可用 `PBMOCKX_INSTALL_DIR` / `PBMOCKX_DATA_DIR` 覆盖。
- 如果终端里的 `pbmockx` 仍指向旧 whistle 插件，执行 `hash -r`，并用 `which -a pbmockx` 确认。
- **从旧版（whistle 插件）升级**：先 `w2 stop` 释放 8899，再执行安装脚本；首次在默认数据目录启动时会自动导入旧的 `whistle-plugin/rules.yaml` 和 `mock-data/`。新 CA 需要重新在各设备上信任。
- 卸载：`./scripts/install.sh --uninstall`；`--purge` 同时删除 `~/.pbmockx` 数据。

## 语言（中文 / English）

CLI 与 Web UI 都支持中英文，**默认跟随系统语言**（`zh*` → 中文，其余 → 英文）：

```bash
pbmockx lang zh                  # 持久切换：写 config.json，运行中的守护进程自动重启
pbmockx lang                     # 查看当前语言、来源（flag / env / config / 系统）
pbmockx lang auto                # 恢复跟随系统
pbmockx --lang zh flows          # 单次命令，不持久化（全局参数，可在子命令前后）
PBMOCKX_LANG=zh pbmockx doctor   # 或环境变量
```

- 优先级：`--lang` > `PBMOCKX_LANG` > `~/.pbmockx/config.json` 的 `"lang"` > 系统 locale > `en`。
- `pbmockx start --lang zh` 会把默认语言一并带给守护进程，Web UI 打开即中文。
- Web UI 顶栏有「中文 / EN」切换按钮，选择记在浏览器本地；也可用 `?lang=zh` 强制某次打开的语言。
- 机器接口不受影响：`--json`、表格表头、`=== Request ===` 分隔符、`OK/WARN/FAIL` 始终英文。

## 快速开始

```bash
pbmockx start                 # 启动代理 + 控制 API + Web UI（默认 127.0.0.1:8899）
pbmockx status                # 查看运行状态 / 端口 / flow 数
pbmockx ca                    # 查看 CA 路径、指纹与各平台安装说明
pbmockx ca --out ./pbmockx-ca.crt   # 导出 CA 证书
```

1. **信任 CA**（HTTPS 必需）：把 CA 证书装到系统/浏览器/设备。UI 的 **Setup & CA** 页有一键下载和 macOS/Windows/Linux/Android 步骤。
2. **配置代理**：HTTP/HTTPS 代理指向 `127.0.0.1:8899`（Android 可用 `pbmockx connect-android`）。
3. **打开 Web UI**：`pbmockx web` 或访问 <http://127.0.0.1:8899/>。
4. 触发一次请求，UI 左侧出现 flow；点开即可看请求/响应与 PB 字段树。

### 局域网设备（手机 / 另一台电脑）

默认只监听 `127.0.0.1`。要让同一 Wi-Fi/LAN 的设备访问：

```bash
pbmockx start --lan            # 等价于 --host 0.0.0.0 + 允许 LAN 访问 UI/API
# 或
pbmockx start --host 0.0.0.0
```

启动日志会打印可用的 LAN 地址（例如 `http://192.168.1.23:8899/`）。
手机/另一台电脑把 HTTP/HTTPS 代理设为 `<LAN-IP>:8899`，UI 直接打开 `http://<LAN-IP>:8899/`。

- Android 走 Wi-Fi（非 USB）时用 `pbmockx connect-android --wifi`，会自动取本机 LAN IP。
- 只想让 LAN 设备用代理、不想暴露 UI/API：在 `~/.pbmockx/config.json` 里设 `"ui": { "lanAccess": false }`。
- **只建议在可信局域网开启**：开启后同网段设备能查看捕获的请求/响应。macOS 防火墙若拦截入站连接，请在“系统设置 → 网络 → 防火墙”中允许 `node`。

```bash
# 用 curl 验证整条链路
curl -x http://127.0.0.1:8899 http://example.com/
curl -x http://127.0.0.1:8899 --cacert ~/.pbmockx/ca/ca.pem https://example.com/
```

## CLI（AI agent 主入口）

```bash
# 抓包查看
pbmockx flows [--filter <regex>] [--json]
pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full] [--headers] [--json]
# proto=tunnel 的行表示这条 CONNECT 没被解密（bypass / 端口 / TLS 握手失败），decode 会打印原因

# Patch：按 path 改响应字段
pbmockx rules add 'api/game' game.name Mocked
pbmockx rules add 'api/game' game.id 999 --protocol pb
pbmockx rules add 'api/game' items --append '{"id":9}'       # repeated 条目：追加
pbmockx rules add 'api/game' items --insert 1 '{"id":8}'     # 插入到 index 1 前
pbmockx rules add 'api/game' items --remove 0                # 删除 index 0
pbmockx rules add 'api/game' game.obsolete --unset           # 删除键
pbmockx rules list [--type patch|map_local|map_remote] [--json]
pbmockx rules del <id> | save | reload

# Map local：整 body 替换
pbmockx map-local add 'api/game' --data '{"game":{"name":"Mocked"}}'
pbmockx map-local add 'api/game' --file /path/to/mock.pb [--status 200]
pbmockx map-local list | del <id>

# Map remote：请求重定向
pbmockx map-remote add 'api/old' 'https://new.example.com/new'
pbmockx map-remote add 'api/(.*)' 'https://mock.local/$1' --regex
pbmockx map-remote list | del <id>

# 守护进程
pbmockx start [--port 8899] [--host 127.0.0.1] [--lan] [--foreground]
pbmockx stop | restart | status [--json] | logs [-f] [-n 100]
pbmockx ca [--out <file>] [--info] [--regen --yes]

# 维护
pbmockx doctor [--json]       # Node / 数据目录 / CA / daemon / 规则 / 流量
pbmockx fix                   # 构建 + 重启 + 验证
pbmockx agent-doc             # 打印 SKILL.md
pbmockx skill install|list|uninstall
pbmockx version [--check]
pbmockx connect-android [-s <serial>] [--wifi [host]]
```

- 所有命令支持 `-h/--help`；读命令支持 `--json`。
- `decode` 默认折叠（节省 token）：嵌套 message 显示 `(type, N fields)`，repeated 显示 `(repeated type, N items)`，长字符串截断；用 `--path` 钻取、`--full` 全展开。
- `--original` 显示 patch 前的响应，便于对比验证。

## Web UI

访问 <http://127.0.0.1:8899/>：

- 左侧实时 flow 列表：method、状态、URL、协议、耗时、大小、mock/error/ws 标记；支持正则/文本过滤、暂停、清空、`j/k` 导航。
- **Flat / Tree 两种视图**：Tree 按 host + URL 路径树聚合（相同接口的多次请求折叠计数），默认全部折叠，点击 host/路径分组逐层展开，展开状态会记住；选中请求所在分组有蓝色标记。长 URL 自动换行；列表宽度可拖拽（双击分隔条复位），并记住上次宽度。
- 右侧详情：Summary（概览、匹配规则、耗时、错误）/ Request / Response；PB 字段树可交互展开；JSON 树；raw/hex 视图；patched ↔ original 切换；复制/下载 body。
- **Rules** 抽屉：按类型分组，新增/删除/启停规则，编辑 `map_local(data)` 的 mock 数据文件，保存/重载 `rules.yaml`。
- **Setup & CA**：代理地址、CA 下载、指纹、各平台安装步骤、数据目录与容量限制。
- 深/浅色主题（`◐` 切换），SSE 实时更新，断线自动重连。

## 数据与配置

默认数据目录 `~/.pbmockx`（可用 `PBMOCKX_DATA_DIR` 覆盖）：

```
~/.pbmockx/
├─ config.json        # 可选：端口/上游校验/抓包上限
├─ runtime.json       # 运行时 pid/port
├─ rules.yaml         # 所有 Mock 规则（自动加载/保存）
├─ mock-data/         # map_local(data) 的 JSON 文件
├─ ca/                # ca.pem / ca.key / leaf.key
├─ desc-cache/        # .desc 条件请求缓存
└─ logs/pbmockxd.log
```

常用环境变量：`PBMOCKX_PORT`、`PBMOCKX_HOST`、`PBMOCKX_DATA_DIR`、`PBMOCKX_LAN`、`PBMOCKX_LOG_LEVEL`、`PBMOCKX_LANG`。旧变量 `WHISTLE_PORT` 仍作为最低优先级回退。

配置示例（`~/.pbmockx/config.json`）：

```json
{
  "port": 8899,
  "host": "127.0.0.1",
  "lang": "zh",
  "ui": { "lanAccess": true },
  "proxy": {
    "mitm": true,
    "mitmPorts": [443, 8443],
    "bypass": ["*.apple.com"],
    "recordTunnels": true,
    "upstreamTLS": { "rejectUnauthorized": true }
  },
  "capture": {
    "maxFlows": 500,
    "maxRecordBodyBytes": 4194304,
    "maxTotalRecordBytes": 268435456,
    "maxRewriteBodyBytes": 67108864
  }
}
```

- `map_remote` 指向 loopback/私网地址时自动跳过上游证书校验（兼容本地 HTTPS mock server）；其他目标默认校验证书。
- **未解密的连接也会出现在 flow 列表**：命中 `bypass`、端口不在 `mitmPorts`、`mitm=false`、TLS 握手失败（CA 没装/证书固定/mTLS/非 TLS 协议）的 CONNECT 会被记录成只含元数据的隧道 flow —— `method=CONNECT`、`url=tcp://host:port`、`tunnel=bypass|port|mitm-disabled|tls-handshake|ca-error`、上下行字节数与关闭方，**不含任何明文**。`"recordTunnels": false` 可关闭。这样「看不到记录」能区分成代理没生效 / 被规则排除 / 证书问题。
- 默认只监听 loopback。绑定 `--host 0.0.0.0` / `--lan` 后，代理、UI、控制 API 都可从 LAN 访问；`ui.lanAccess=false` 可只暴露代理（CA 下载端点仍允许，方便设备装证书）。

## 限制

- 暂不支持 HTTP/2 / gRPC（MITM 的 ALPN 只提供 `http/1.1`；上游统一 HTTP/1.1）。纯 h2/gRPC 接口请用 `proxy.bypass` 走原始隧道，或等待后续版本；这类连接会以 `tunnel=tls-handshake` 或 `tunnel=bypass` 的元数据记录出现在列表里。
- mTLS 双向认证流量无法中间人解析，建议 bypass。
- 没有 breakpoint/intercept：用 patch 规则 + `rules reload` 实现动态修改。
- WebSocket 仅隧道透传并记录字节数，不解析帧内容。
- flow 保存在内存（LRU + 总字节上限），重启后清空。

## 开发

```bash
npm install                 # 如沙箱限制 npm 缓存：npm install --cache .npm-cache
npm run build               # tsc → dist/
npm run typecheck
npm test                    # node:test（核心 / CA / HTTP / HTTPS / PB / CLI）
node bin/pbmockx.js --data-dir .dev-data start --port 8899
```

目录：`src/core`（PB/规则/流存储）、`src/proxy`（代理/CA）、`src/mock`（规则执行）、
`src/server`（守护进程/控制 API/静态 UI）、`src/cli`、`web/`。开发细节见 `AGENTS.md`。

## 从 whistle 迁移

| 旧 | 新 |
|---|---|
| `w2 start/stop/status` | `pbmockx start/stop/status` |
| `w2 ca` | `pbmockx ca` |
| `pbmockx` via `w2 exec` | 直接 `pbmockx`（`npm link` 后） |
| `whistle-plugin/rules.yaml` | `~/.pbmockx/rules.yaml`（首次启动自动导入） |
| whistle CA | pbmockx CA（需重新信任） |
| `pipe://pbmockx` 规则 | 不需要（所有流量默认经过 pbmockx） |

## License

MIT
