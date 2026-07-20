# AGENTS.md — pbmockx 开发指南

面向 Agent 的高信噪比上下文。用户使用指南在 `docs/SKILL.md`（`pbmockx help`/`agent-doc` 打印）——本文件只覆盖开发者关注点。

## 架构

两个 Node.js 运行时，同一进程内通过插件 hook 与 CGI API 连接：

```
whistle (:8899, Node.js)  ──加载──►  whistle.pbmockx 插件（进程内）
                                              ├─ resRead/reqRead hook（gunzip→decode→Any展开→patch→Any回包→encode，pipe 单向）
                                              ├─ resWrite/reqWrite hook（passthrough）
                                              ├─ rulesServer（map_remote/map_local file → whistle 原生规则）
                                              └─ uiServer（Koa CGI，规则 CRUD + flow 查询 + decode-pb）

pbmockx CLI（whistle-plugin/bin/cli.js）  ──HTTP──►  uiServer CGI（/cgi-bin/*）
  通过 w2 exec pbmockx 或 npm link 后直接 pbmockx 调用
```

- **whistle** 是宿主进程（默认 :8899），通过 `whistleConfig`（package.json）声明 `inspectorsTab`——只有 `req` 和 `res` 两个子 tab，都命名为 `"PBView"`，action 指向 `/public/pb-req.html` 与 `/public/pb-res.html`。**没有 `networkColumn`**（已按用户要求移除），也没有顶层 `name`/`action` 字段。
- **whistle.pbmockx** 插件由 `whistle-plugin/index.js` 导出 6 个 hook（resRead/reqRead/resWrite/reqWrite/rulesServer/uiServer）。所有 hook 共享同一 Node 进程，模块级单例（`src/ctx.ts`）提供 `PBEngine`、`RuleEngine`、`FlowStore` 实例。
- `whistle-plugin/src/*.ts` 编译到 `dist/src/`（tsc）。`index.js` 用 `require('./dist/src/<name>').default` 加载，try/catch 隔离单个 hook 失败。
- `whistle-plugin/public/` 是 inspectorsTab 的 HTML——`pb-req.html` 与 `pb-res.html`，**JS 内联在 HTML 里**（whistle 不通过 HTTP 提供 public/ 静态文件，外部 `<script src>` 无法加载，只能走 inspectorsTab action 机制）。HTML 内通过 `whistleBridge` 拉取 session body，POST 到 `/cgi-bin/decode-pb` CGI 渲染字段树。
- **pipe hook 接收的 body 即 HTTP 请求 body**：resRead 里响应体通过 `req` stream 传入，**响应头在 `req.headers`**（`req.originalRes` 只有 `serverIp` 和 `statusCode`，**不含完整响应头**）；reqRead 里请求头在 `req.headers`，请求体同样通过 `req` stream 传入。
- **gzip/deflate/br 解压**：pipe hook 在 decode 前按 `content-encoding` 用 `zlib.gunzipSync`/`inflateSync`/`brotliDecompressSync` 解压。**返回 UNCOMPRESSED body（不重新压缩）**——whistle pipe（方案二）把它当 plaintext 处理，自动剥离 `content-encoding`，客户端和 Web UI 看到的都是原始字节。
- **Any 展开/回包**（`src/any-expand.ts`）：patch 前对包含 `google.protobuf.Any` 字段的 message 调用 `expandAny`，按 `type_url` 在 root 里查类型、把 `value` bytes 解码为内层 message 对象（替换原 Any 字段为展开后的 message）；patch path 可直接导航到内层业务字段（如 `data.value.list[0].app.title`，`data` 是 Any，`value` 是内层 message）。patch 完成后调用 `packAny` 把展开的 message 重新编码为 bytes、包回 Any。**不修改 `@type` / `type_url`**。
- `whistle-plugin/bin/cli.js` 是 CLI 入口（package.json 的 `"bin": {"pbmockx": "./bin/cli.js"}`）。`w2 exec pbmockx <cmd>` 或 npm link 后直接 `pbmockx <cmd>`。所有命令支持 `-h`/`--help`。
- **`whistle-plugin/rules.txt`** 是插件级规则文件（`* pipe://pbmockx`）——whistle 加载插件时自动注入，**无需用户在 Web UI 里手写 `pipe://pbmockx` 规则**。所有请求默认走 pipe（decode→patch→encode）；用户想选择性 pipe 时，可在 whistle UI 里加更具体的 `pattern pipe://pbmockx` 规则覆盖。
- `scripts/install.sh` 检查 Node.js≥18 → 检查/安装 whistle → 构建插件（tsc）→ `npm link`（让插件全局可用，`w2 start` 自动加载）→ 重启 whistle 加载插件 + rules.txt → skill install。`--uninstall` 反向清理：清旧 w2 add 规则 + `w2 uninstall` + `npm unlink -g` + `pbmockx skill uninstall` + 删除克隆仓库。**不检查 lack**（dev-only 工具）。
- **已删除的文件**（历史版本曾有）：`bin/pbmockx`（旧 Python CLI）、`scripts/start.sh`（旧 mitmproxy 启动脚本）、`addon/pbmockx_addon.py`（Python mitmproxy addon）、`scripts/start-mitmproxy.sh`（mitmproxy fallback 启动）、`whistle-plugin/public/pb-view.html` 和 `pb-view.js`（JS 已内联进 `pb-req.html`/`pb-res.html`）。

## 命令

```bash
# 安装
./scripts/install.sh    # 检查 Node≥18 + whistle + 构建 + npm link + skill
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"  # 远程一行

# 启动
w2 start                                 # npm link 后插件全局可用，w2 自动加载（含 rules.txt）
# 本地开发用 w2 start -A whistle-plugin 也可直接加载插件目录

# CLI（pbmockx 命令，通过 npm link 或 w2 exec；所有命令支持 -h/--help）
pbmockx flows [--filter <regex>]                          # 列出已 decode 的 flow（单 ID 同时含 req+res，无 dir 列）
pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full]
                                                          # 显示 headers + body（PB 用 renderTree）
                                                          #   默认折叠模式（节省 token）：顶层 scalar 显示值，
                                                          #     嵌套 message/repeated 显示 (type, N) ▸，长字符串截断
                                                          #   --path <path> 导航到子树（折叠显示），路径含 [n] 需加引号
                                                          #   --full        完整展开所有层级（不截断）
pbmockx rules add|list|del|save|reload ...               # patch 规则 CRUD（path 可穿透 google.protobuf.Any）
pbmockx map-local add|list|del ...                        # map_local 规则（--data/--file）
pbmockx map-remote add|list|del ...                       # map_remote 规则（--regex）
pbmockx web                                                # 打开 whistle Web UI
pbmockx connect-android [-s <serial>]                     # Android 代理 + 证书指引
pbmockx doctor                                             # 全链路检查（node/whistle/plugin/link/version）
pbmockx fix                                                # 自动修复：rebuild→npm link→w2 restart→verify
pbmockx agent-doc                                          # 打印 SKILL.md
pbmockx skill install|list|uninstall                      # 安装 SKILL.md 到 agent 目录（~/.agents + ~/.claude）
pbmockx version [--check]                                  # 版本（可选检查 GitHub release）
w2 exec pbmockx <cmd>                                      # 未 npm link 时的替代调用

# 测试（100% Node.js）
cd whistle-plugin && npm test              # tsc + node -e "require('./dist/tests/test_pb-engine').run()"

# 开发
cd whistle-plugin && npx tsc -w            # watch 模式编译
lack watch                                 # 如已安装 lack（dev-only）

# Lint / typecheck
cd whistle-plugin && npx tsc --noEmit
```

`npm test` 先跑 `tsc` 编译 `src/*.ts` + `tests/*.ts` 到 `dist/`，再 `require('./dist/tests/test_pb-engine').run()` 跑单元测试。`whistle-plugin/tests/test_server.ts` 是 protobufjs 构建的 mock server（用于 resRead pipe 端到端验证）。无测试框架——纯 assert + `run()` 入口。

## 规则引擎（4 种类型）

`RuleEngine`（`whistle-plugin/src/ruleEngine.ts`）——统一规则存储，`type` 字段选择属性：

| type | 落点 | 关键字段 | 作用 |
|---|---|---|---|
| `patch` | resRead（pipe） | `path`, `value`, `protocol` | 在 message 对象上按 path set 字段（path 可穿透 `google.protobuf.Any`——pipe hook 先 `expandAny` 再 patch 再 `packAny`），fromObject→encode |
| `map_local` (data) | resRead（pipe） | `data_file`, `desc`, `messageType` | 整 body 替换为外部 JSON 文件，PB encode 后下发 |
| `map_local` (file) | rulesServer（whistle 原生） | `file_path` | 翻译为 whistle `file://` 原生规则，由 whistle 替换 body |
| `map_remote` | rulesServer（whistle 原生） | `replacement`, `is_regex` | 翻译为 whistle `xxx://` 原生规则，重写 url + Host |

**执行顺序**：`map_remote(rulesServer, request) → map_local file(whistle 原生, request) → map_local data(resRead, response) → patch(resRead, response)`。前两类在请求阶段由 whistle 原生规则处理；后两类在响应阶段由 pipe resRead 处理。

- **rules.yaml** 存储所有规则（js-yaml 读写）。启动时加载（`RuleEngine.reload`），add/del 时自动保存（`RuleEngine.save`）。`.gitignore` 排除 `rules.yaml`（运行时生成），仓库里有 `rules.yaml.example` 作为模板。
- **map_local data** 的 mock 数据存在 `whistle-plugin/mock-data/<id>.json` 外部文件，规则里只存 `data_file` 引用。`.gitignore` 排除 `mock-data/`。
- **规则 ID**：`crypto.randomBytes(4).toString('hex')`（8 字符 hex）。
- **pipe 触发条件**：只有匹配 `pattern pipe://pbmockx` 的请求才会进入 resRead/reqRead。插件加载时通过 `whistle-plugin/rules.txt` 自动注入 `* pipe://pbmockx` 全量规则，无需用户手动配置；用户也可在 whistle UI 里加更具体的 `pattern pipe://pbmockx` 规则做选择性 pipe。rulesServer 会对有 patch/map_local data 规则的 pattern 注入对应 pipe 规则。

## 关键陷阱

### PB 类型不匹配（已大幅缓解，但仍需注意）
protobufjs 直接操作 message 对象（`fromObject`/`toObject`），**不做 JSON 中转**——避免了 Python 时代 int64→string / enum→string name 的歧义。但仍有边界：
- **int64/uint64** → JS `number`（protobufjs 默认，超出 `Number.MAX_SAFE_INTEGER` 才用 `long`）。patch 时传 `123`（number）或字符串数字。`"sku1"` 这种非数字字符串仍会 encode 失败。
- **enum** → JS `number`（不是字符串名）。patch 时传数字或名字（`fromObject` 接受两者）。
- **bytes** → `Uint8Array` 或 base64 字符串（取决于 decode 模式）。patch 时传 base64 字符串最稳妥。
- **google.protobuf.Any** → 有 `@type` 元数据。**不要修改 `@type`**。
- **加 patch 规则后务必检查 `patch_error`**（decode 输出里能看到 encode 失败原因）。

### map_local data 缺 desc/messageType 会 encode 失败
map_local(data) 需要 `desc`（.proto 描述符 base64 或文件路径）+ `messageType` 才能 PB encode。缺一个就用 `JSON.stringify` 兜底（非 PB body）。`data_file` 指向 `mock-data/<id>.json`，文件内容是已 decode 的 JSON 对象。

### Patch 直接操作 message 对象
Patch 不再走 dict→JSON→re-encode。直接在 `decodeDelimited` 返回的 message 对象上 `set_by_path`，再 `encodeDelimited`。`fromObject` 会做类型强转（字符串数字→number），但仍受 PB 类型约束（int64 不能传非数字字符串）。

### pipe 只对匹配 `pattern pipe://pbmockx` 的请求触发
resRead/reqRead 是单向 pipe hook——**只对配置了 `pipe://pbmockx` 的 pattern 生效**。插件加载时通过 `rules.txt` 自动注入 `* pipe://pbmockx` 全量规则，所以默认所有请求都走 pipe；用户也可在 whistle UI 里加更具体的 `pattern pipe://pbmockx` 规则做选择性 pipe。rulesServer 还会对有 patch/map_local(data) 规则的 pattern 注入对应 pipe 规则。未走 pipe 的请求，patch/map_local(data) 不生效（但 map_remote/map_local(file) 仍由 rulesServer 原生规则处理）。

### pipe hook 的头与 body 位置（容易踩坑）
- **resRead**：响应头在 `req.headers`（`req.originalRes.headers` 只有 `serverIp` 和 `statusCode`，**不含完整响应头**——别去 `req.originalRes.headers` 拿 content-type/encoding）。响应体通过 `req` stream 传入（pipe hook 把它当作 HTTP 请求 body 接收）。
- **reqRead**：请求头在 `req.headers`，请求体通过 `req` stream 传入。
- 读 body 用 `readBody(req)`（`src/helpers.ts`），聚合 chunk 后返回 Buffer。

### gzip/deflate/br 必须先解压再 decode
pipe hook 在 decode 前按 `content-encoding` 用 `zlib.gunzipSync`/`inflateSync`/`brotliDecompressSync` 解压。**encode 后返回 UNCOMPRESSED body（不重新压缩）**——whistle pipe（方案二）把它当 plaintext 处理，自动剥离 `content-encoding`，所以客户端和 Web UI 看到的都是原始字节。如果跳过解压直接 decode，gzip 流会被当成 PB 解析失败。

### Extra WKT 加载 + `Root.fromDescriptor` monkey-patch
protobufjs `common` 只内置 7 个 WKT（any/timestamp/duration/struct/wrappers/field_mask/empty）。但 TapTap 的 `.desc` 里有自定义 extension 扩展 `google.protobuf.MethodOptions`/`FieldOptions` 等，这些 Options 类型不在 `common` 里。`pb-engine.ts` 做两件事：

1. **加载 4 个额外 WKT**——从 `protobufjs/google/protobuf/*.json` 通过 `root.addJSON()` 注入：`descriptor.json`（关键，定义 `MethodOptions`/`FieldOptions` 等 Options 类型）、`api.json`、`source_context.json`、`type.json`。
2. **Monkey-patch `Root.fromDescriptor`**——原版内部会调用 `resolveAll()`，对未解析的扩展直接抛错。我们临时把 `resolveAll` 替换成 no-op，调完原 `fromDescriptor` 再恢复，最后由我们自己在 try/catch 里调 `resolveAll()`（非致命错误可忽略——custom options 只是元数据，不影响 decode/encode）。

### 没有 breakpoint 功能（v0.4.0 移除）
web 交互式断点难以设计，已移除。**一律用 patch 规则**实现响应修改。

## 约定

- **`docs/SKILL.md` 是唯一真理来源**——`pbmockx help`/`agent-doc` 打印它。改动会传播给所有 agent。保持 frontmatter（`name`、`description` 及触发词）完整。
- CLI 在 `whistle-plugin/bin/cli.js`（Node.js），通过 `w2 exec pbmockx` 或 npm link 后直接 `pbmockx` 调用。手写 argv 分发，`cmd_<verb>` 函数。**所有命令支持 `-h`/`--help`**。`decode <id>` 显示 headers + body，支持 `--req`/`--res`（只看请求或响应）/`--original`（pre-patch 原始数据）/`--path <path>`（导航到子树，折叠显示）/`--full`（完整展开）。**默认折叠模式**（v0.4.0 新默认）：顶层 scalar 显示值，嵌套 message 显示 `(type, N fields) ▸`，repeated 显示 `(repeated type, N items) ▸`，长字符串截断到 80 字符——适合 AI agent 节省 token。PB 输出用 `renderTree`（`field-tree.ts`）渲染成字段树。
- **flow_store**（`src/flow-store.ts`）：**upsert by session ID**——同一个 whistle session ID（如 `1784529570691-003`）同时持有 request 和 response 数据（v0.4.0 合并了 REQ/RES 双 ID）。reqRead 上报时 upsert 到 `req` 字段，resRead 上报时 upsert 到 `res` 字段，**不创建新条目**。`flows` 列表每条请求一行（无 `dir` 列），`decode <id>` 同一 ID 同时显示 Request 和 Response（`--req`/`--res` 只过滤显示哪部分，不是找另一个 flow）。LRU 上限（满后淘汰最旧的）。
- **`lack` 是 dev-only 工具**——不在 `install.sh` 里，不写入 dependencies。开发者自行安装用于 watch/reload。
- **Node.js ≥ 18**（`install.sh` 强制）。protobufjs v7 + `ext/descriptor`（需要 Node 18+ 的 `URL`/`fetch` 支持）。
- **TypeScript，不开 strict 模式**（`tsconfig.json` 未设 `"strict": true`）。源码在 `src/`，编译到 `dist/src/`；测试在 `tests/`，编译到 `dist/tests/`。
- 运行时依赖：`protobufjs` + `long` + `js-yaml` + `koa` + `@koa/router` + `koa-bodyparser`。dev 依赖：`typescript` + `@types/*`。
- **inspectorsTab 的 JS 内联在 HTML 里**——`whistle-plugin/public/pb-req.html` 和 `pb-res.html` 各自内联自己的 `<script>`。whistle 不通过 HTTP 提供 public/ 静态文件（只能走 inspectorsTab action 机制），所以外部 JS 文件无法 `<script src>` 加载。
- **whistleBridge API**：用 `bridge.addSessionActiveListener(handleSession)` 订阅 session 切换（不是 `bridge.on('sessionActive')`——那个 API 不存在；HTML 里有 fallback 但首选前者）。init 时还要调 `bridge.getActiveSession()` 处理当前已选中的 session。
- **field-tree.ts**：`buildFieldTree` 是 **async**（因为要解码 `google.protobuf.Any` 的嵌套 message），需要传 `root` 参数以便按 `type_url` 查 Any 的内部类型。`renderTree` 输出格式：`name#N`（带字段号）、空字段显示 `(unset)`、enum 显示 `数字 (名字)`、bytes 显示 base64 截断 + 字节数、Any 显示 `Any → TypeName` 后展开嵌套字段。
- **Legacy addon 已删除**：`addon/pbmockx_addon.py` 和 `scripts/start-mitmproxy.sh` 已移除，不再保留 Python fallback。
- `pbmockx.log` / `flowmock.log` 是运行时日志（whistle daemon 的 stdout/stderr 重定向）。`.gitignore` 排除 `*.log`。
- Git：main 分支。发版 = `git tag vX.Y.Z` + `gh release create`。VERSION 文件是权威版本来源，`whistle-plugin/package.json` 的 `version` 字段同步。

## 版本 + 发版流程

```bash
echo "0.4.0" > VERSION
# 同步 whistle-plugin/package.json 的 "version" 字段
# 更新 CHANGELOG.md
git add VERSION whistle-plugin/package.json CHANGELOG.md && git commit -m "release: v0.4.0"
git tag v0.4.0 && git push && git push --tags
gh release create v0.4.0 --notes-file CHANGELOG.md --title "v0.4.0"
```

`pbmockx doctor` 非阻塞请求 `releases/latest` API 检测新版本（缓存 1h，`~/.pbmockx/.version_cache`）。VERSION 文件是权威版本来源，CLI 启动时读取并与 GitHub release 比对。
