# pbmockx

whistle 插件，抓包查看/修改 **protobuf + JSON** 数据，专为 AI agent 工作流设计。

插件自动识别协议（按 Charles Protocol Buffers 自描述规则：Content-Type 携带 `desc`/`messageType`/`delimited`），直接在 PB message 对象层面操作（不走 JSON 转换），AI agent 通过 CLI 按 path 改字段，不碰 protobuf wire format。

## 能力

- **PB 字段树查看**：whistle Network → Request/Response 区的 **PBView** 子标签页（不是独立父级 tab），展示结构化字段树。格式 `name#N (type) = value`——字段名 + **字段号**（`#N`）+ 类型标注 + 值，默认折叠，可展开/折叠。int64 显示数字 + `(int64)`，enum 显示数字 + 名字 + `(enum)`，`google.protobuf.Any` 按 `type_url` 嵌套解码（显示 `Any → <type>`）；未设置字段显示 `(unset)`（灰色）
- **JSON pretty-JSON**：whistle 自带，插件不管
- **PB + JSON 统一 mock**：
  - `patch`：按 path 改字段（PB message 对象层面操作，不走 JSON；path 可穿透 `google.protobuf.Any` 字段——pipe hook 自动展开/回包）
  - `map_local(data)`：dict → PB encode 整 body 替换
  - `map_local(file)` / `map_remote`：whistle 原生规则（rawfile:// / https://）
- **pipe 单向 mock**：`pattern pipe://pbmockx` 启用「解压 gzip/deflate/br → decode → 展开 Any → patch → 回包 Any → encode」管道（响应头取自 `req.headers`），返回未压缩 body 由 whistle 处理 content-encoding
- **rulesServer 自动翻译**：map_remote / map_local(file) 规则自动翻译为 whistle 原生规则
- **持久化规则**：rules.yaml 实时写回，map_local(data) 数据存外部 mock-data/ 文件
- **CLI + w2 exec + SKILL.md**，所有命令支持 `-h`/`--help`，多 agent 通用

## 安装

### 一行安装
```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
```

install.sh 会：
1. 检查 Node.js >= 18
2. 检查/安装 whistle（>= 2.9.100）
3. 构建插件（tsc）
4. npm link（让插件全局可用，`w2 start` 自动加载 + 注入 `rules.txt` 里的 `* pipe://pbmockx`）
5. 重启 whistle 以加载插件 + rules.txt
6. 安装 SKILL.md 到 agent skill 目录（`~/.agents/skills/` + `~/.claude/skills/`）

### 更新
```bash
pbmockx version --check                    # 检查更新
# 或
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)" -- --update
```
### 证书
```bash

## 启动
```bash
w2 start                                 # npm link 后插件全局可用，w2 自动加载（含 rules.txt）
```
> 插件加载时通过 `whistle-plugin/rules.txt` 自动注入 `* pipe://pbmockx` 全量规则，
> 所有请求默认走 pipe（decode→patch→encode + gzip 解压 + Any 展开/回包），无需手动在 whistle UI 写 pipe 规则。
> 如需选择性 pipe，可在 whistle UI 里加更具体的 `pattern pipe://pbmockx` 规则。

## CLI（AI agent 用）

通过 `w2 exec pbmockx <cmd>` 或 npm link 后直接 `pbmockx <cmd>`：

```bash
# 查看
pbmockx flows [--filter <regex>]                # decoded flow 列表（单 ID 同时含 req+res，无 dir 列）
pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full]
                                                #   默认折叠模式（节省 token，适合 AI agent）：
                                                #     顶层 scalar 显示值，嵌套 message/repeated 显示 (type, N) ▸，
                                                #     长字符串截断到 80 字符加 ...
                                                #   --req/--res      只看 Request 或 Response（同一 flow，不是找另一个 flow）
                                                #   --original       显示 patch 前原始数据（对比）
                                                #   --path <path>    导航到子树（折叠显示），路径含 [n] 需加引号
                                                #   --full           完整展开所有层级（不截断）

# Mock — patch（按 path 改字段）
pbmockx rules add 'api/game' game.name 测试     # patch 规则（PB/JSON 通用）
pbmockx rules list [--type patch|map_local|map_remote]
pbmockx rules del <id>
pbmockx rules save / reload

# Mock — map-local（整 body 替换）
pbmockx map-local add 'api/game' --data '{"name":"test"}' [--desc <url>] [--messageType <type>]
pbmockx map-local add 'api/game' --file /path/to/mock.pb    # whistle native rawfile://
pbmockx map-local list / del <id>

# Mock — map-remote（请求重定向，whistle native）
pbmockx map-remote add 'api/old' 'https://new.example.com/new' [--regex]
pbmockx map-remote list / del <id>

# 进程管理（w2 原生）
w2 start / w2 stop / w2 restart / w2 status
w2 ca                                          # PC 证书

# 工具维护
pbmockx web                                    # 打开 whistle UI
pbmockx doctor                                 # 全链路健康检查（含 npm link 状态）
pbmockx fix                                    # 自动修复：rebuild→npm link→w2 restart→verify
pbmockx agent-doc                              # 打印 SKILL.md
pbmockx skill install                          # 安装 SKILL.md 到 agent 目录（~/.agents + ~/.claude）
pbmockx version [--check]                      # 版本 + 远程检查
pbmockx connect-android [-s <serial>]          # Android 代理 + 证书

# 帮助
pbmockx -h / --help                            # 顶层帮助
pbmockx <command> -h / --help                  # 各命令的详细帮助（flows/decode/rules/map-local/map-remote/web/doctor/connect-android/version）
```

## 接入 agent
- **opencode / Claude Code**：`pbmockx skill install` 自动装到 `~/.agents/skills/pbmockx/` 和 `~/.claude/skills/pbmockx/`
- **其他 agent**：跑 `pbmockx agent-doc` 取使用说明注入 system prompt

## 文件
- `whistle-plugin/` — whistle.pbmockx 插件（TS 源码 + CLI + PBView 子标签页）
  - `src/pb-engine.ts` — PB 引擎（protobufjs + long，monkey-patch `fromDescriptor` 跳过 `resolveAll`，`addJSON` 加载 `descriptor.json` 等 WKT）
  - `src/any-expand.ts` — `google.protobuf.Any` 展开/回包（patch path 穿透 Any 字段时使用：按 `type_url` 解码 value bytes → 应用 patch → 重新编码为 bytes）
  - `src/flow-store.ts` — flow 存储（upsert by session ID，单 ID 同时持有 req+res，LRU 上限）
  - `src/resRead.ts` / `reqRead.ts` — pipe hooks（解压 gzip/deflate/br → decode → 展开 Any → patch → 回包 Any → encode，响应头取自 `req.headers`）
  - `src/rulesServer.ts` — map_remote/map_local(file) → whistle 原生规则
  - `src/uiServer/` — Koa CGI（规则 CRUD + flow 查询 + decode-pb）
  - `public/pb-req.html` / `pb-res.html` — PBView 子标签页（Request/Response 各一份，JS 内联无外部脚本），通过 whistleBridge 的 `addSessionActiveListener` + `getActiveSession` 拉取 session body
  - `bin/cli.js` — Node.js CLI（支持 `-h`/`--help`，`decode` 默认折叠模式 + `--path`/`--full`）
  - `rules.txt` — 插件级规则（`* pipe://pbmockx`），加载插件时自动注入，全量 pipe 无需手写
- `scripts/install.sh` — 一键安装（Node.js + whistle + 构建 + npm link + skill）；支持 `--update` / `--uninstall`
- `docs/SKILL.md` — agent 文档（与 CLI `agent-doc` 同源）
- `rules.yaml.example` — 规则模板
- `tests/test_server.ts` + `test_pb-engine.ts` — 测试（100% Node.js）

> 已删除：`bin/pbmockx`（Python CLI）、`scripts/start.sh`、`addon/pbmockx_addon.py`、`scripts/start-mitmproxy.sh`、旧版 `public/pb-view.html` + `pb-view.js`（已合并进 `pb-req.html` / `pb-res.html`）。whistle `networkColumn`（PB Type 列）也已移除。

## 与 Charles 对比
| | Charles | pbmockx (whistle) |
|---|---|---|
| PB schema | `.desc`/`.proto` | `.desc`（同 Charles 规则） |
| PB 查看 | Structured Viewer | PBView 子标签页字段树（`name#N (type) = value`，带类型标注） |
| PB 修改 | Structured 双击改 | CLI path+value（AI 可操作） |
| JSON 查看 | Text | whistle pretty-JSON |
| Map Local | 整文件替换 | 整文件 + dict→PB encode |
| Map Remote | URL 映射 | 完整 URL + regex 替换 |
| Patch | 无 | path 导航改字段 |
| 持久化规则 | 启动时配置 | rules.yaml 实时写回 |
| AI 接入 | 无 | CLI + w2 exec + agent-doc |
| 类型歧义 | 无 | 无（不走 JSON 转换） |

## 相关

- [whistle](https://github.com/avwo/whistle) — Node.js 调试代理（本项目宿主）
- [protobufjs](https://github.com/protobufjs/protobuf.js) — Protocol Buffers 实现（PB 引擎）
- [lack](https://github.com/avwo/lack) — whistle 插件脚手架（开发用）

## License

MIT
