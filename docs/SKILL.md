---
name: pbmockx
description: >
  pbmockx helps you mock and inspect Protobuf/JSON API responses through whistle.
  Use when you need to: mock data, change API response fields, view protobuf
  responses, debug PB/JSON API calls, map local/remote, patch response fields.
  Triggers: 抓包, mock数据, 改接口返回, 看PB/JSON响应, map local, map remote,
  patch, breakpoint, protobuf, 调试接口, pbmockx.
---

# pbmockx — Agent 指南

pbmockx 是一个 **whistle 插件**，会自动识别每个抓包 HTTP 响应的协议（protobuf
或 JSON）。**关键差异**：PB 响应**不会被转换成 JSON** —— 你在 whistle 的
**PBView** sub-tab 看到的是结构化字段树（`name#N (type) = value` 格式，带
类型标注），patch / map_local 等操作都直接作用于 message 对象本身。这避免了
JSON 转换中的 int64→string / enum→string 歧义。

进程拓扑：

```
w2（whistle CLI）  ──►  whistle 进程（含 pbmockx 插件）
                          ├─ network: 抓包与查看（Request/Response 下的 PBView sub-tab）
                          ├─ pipe://pbmockx: 自动解压 → 解码 → patch → 重新编码（返回未压缩 body）
                          └─ CGI: /plugin.pbmockx/cgi-bin/...（CLI 走这条路）
```

- 进程管理用 `w2 start/stop/restart/status`（不是 `pbmockx start/stop`）。
- PC 证书：`w2 ca`。Android：`pbmockx connect-android [-s <serial>]`。
- CLI：`w2 exec pbmockx <cmd>`（推荐），或 `npm link` 后直接 `pbmockx <cmd>`。
- 所有 CLI 命令最终都走插件的 CGI API：`/plugin.pbmockx/cgi-bin/...`。
- **PBView 不是顶层 tab**：它是 Request 和 Response 区域下各自的 sub-tab
  （通过 `whistleConfig.inspectorsTab.req/res` 注册，两个 tab 都叫 "PBView"，
  分别对应 `pb-req.html` / `pb-res.html`）。在 Network 里点开请求后，切到
  Request → PBView 看请求体字段树，切到 Response → PBView 看响应体字段树。
- **每个 CLI 命令都支持 `-h` / `--help`**（如 `pbmockx decode -h`、
  `pbmockx rules -h`）；主帮助：`pbmockx --help` 或 `pbmockx -h`。

## 1. 前置检查 — 每次首先执行

在做任何事之前，先运行 `pbmockx doctor`。它会检查整条链路：
w2 / 插件 / 规则 / 流量。解读结果：

| 结果 | 含义 | 操作 |
|---|---|---|
| w2: NOT running | whistle 未启动 | 运行 `w2 start`（后台 daemon，非阻塞）。 |
| plugin: NOT loaded / NOT REACHABLE | 插件未注册或 npm link 失效 | 运行 `pbmockx fix`（自动 rebuild → npm link → w2 restart → verify）。若仍未恢复，检查 `npm ls -g whistle.pbmockx`，必要时重新跑 `./scripts/install.sh`。 |
| plugin: OK, traffic: NO traffic | 插件已加载但没有流量 | 代理/证书未就绪 或 应用空闲。让用户操作应用（打开页面/搜索）触发流量，然后重新检查。如果应用有活动后流量仍为 0 → 证书未安装或设备代理未设置（指引：PC 运行 `w2 ca` 安装 CA；Android 设备运行 `pbmockx connect-android` 配置代理）。 |
| plugin: OK (flow_count=N>0) | 就绪 | 进入工作流 |
| npm link: NOT LINKED | `pbmockx` 短命令不可用（插件本身可能正常） | 运行 `pbmockx fix` 重新 link；在修复前用 `w2 exec pbmockx <cmd>` 代替。 |

永远不要假设 whistle 已在运行 —— 必须先用 `doctor` 验证。

## 2. 标准工作流 — 按此顺序执行

**第 1 步 — 找到目标 flow：**
```
pbmockx flows
```
输出列：`id  dir  method  status  protocol  messageType  url`。`dir` 是 `REQ` 或
`RES`（分别来自 reqRead 和 resRead pipe），`protocol` 是 `protobuf` / `json`
（空表示未识别），`messageType` 是 PB 全限定消息类型名。记下你要 mock 的 flow
的 `id`（接受前 8 位）和方向/协议。
- 肉眼过滤：找到与你测试功能匹配的 URL 路径。
- `dir=RES  protocol=protobuf` = PB 响应接口；`dir=RES  protocol=json` = JSON 响应。
- `ERR:...`（decode 失败时 `protocol` 可能为空且 `decode <id>` 报错）—— 见故障排查。
- 用 `--filter <regex>` 缩小范围：`pbmockx flows --filter api/game`
- 也可直接在 whistle UI 里翻 Network（更直观）。

**第 2 步 — 查看解码后的结构：**
- **PB flow**：在 whistle UI 的 Network 里点开该请求，切到 **Response → PBView**
  sub-tab（看响应）或 **Request → PBView** sub-tab（看请求体）。看到的是
  结构化字段树，格式为 `name#N (type) = value`：
  - `#N` 是 protobuf 字段编号（field id），不是数组下标。
  - `(int64)` / `(enum Status)` / `(bytes, 12B)` / `(repeated Type)` 是类型标注。
  - **未设置的字段**显示灰色 `(unset)`；repeated 字段未设置显示 `[]`。
  - **默认折叠**，点击行首 `▸` 展开（展开后变 `▾`）。从这里抄出你要改的字段的 path。
- **JSON flow**：PBView 会显示 `JSON — use the Body tab`，请在 whistle 原生
  Body tab 查看 pretty-JSON。
- 或 CLI：`pbmockx decode <id>` —— 默认按 flow 方向显示：
  - `dir=RES` flow 显示 Response headers + body（PB 字段树或 pretty JSON）。
  - `dir=REQ` flow 显示 Request headers + body。
  - `pbmockx decode <id> --req`：找到并显示匹配的 **请求** flow（基于同 URL）。
  - `pbmockx decode <id> --res`：找到并显示匹配的 **响应** flow。
  - `pbmockx decode <id> --original`：显示应用任何 patch 规则**之前**的原始数据。
  - 输出格式：`=== Response ===` + 状态行 + headers + 空行 + `=== Response Body (PB: <type>) ===`
    + `renderTree` 字段树（`name#N (type) = value`，与 PBView 同格式）。
- **google.protobuf.Any 字段**：PBView / CLI 会基于 `type_url` 自动解码内层
  message，显示为 `field#N (Any → actual.Type)`，嵌套字段直接展开在下面。
  **不要修改 `@type` / `type_url`** —— 只改内层业务字段。

**第 3 步 — 决定 mock 方式：**

决策树（按优先级）：

1. **知道要改哪个字段？** → **Patch 规则**（`rules add`）—— 推荐。
   自动修改匹配的响应，不暂停、不超时。PB 和 JSON 都适用。
2. **需要替换整个响应 body？** → **Map Local**（`map-local add`）。
3. **需要把请求重定向到另一台服务器？** → **Map Remote**（`map-remote add`）。

> ⚠️ v0.4.0 起**移除 breakpoint / intercept**（whistle 原生不支持，且容易
> 导致客户端超时）。需要"运行时动态决定"的场景，改用 patch 规则配合
> `pbmockx rules reload` 热更新。

### 2.1 Patch — 按路径修改指定字段（推荐，不暂停、不超时）

patch 通过 whistle 的 **pipe 机制**生效：插件加载时由 `whistle-plugin/rules.txt`
自动注入 `* pipe://pbmockx` 全量规则，pbmockx 会接管所有请求 —— **自动解压
gzip/deflate/br** → 解码 → 应用 patch 规则 → 重新编码 → 返回**未压缩** body
（whistle 会自动处理 `content-encoding`，无需手动 re-compress）。**不暂停、不超时。**
（如需选择性 pipe，可在 whistle UI 里加更具体的 `pattern pipe://pbmockx` 规则覆盖。）

**标准工作流（Agent 首选）：**
```
# 1. 先抓一个真实请求（或让用户触发一次）
pbmockx flows --filter 'api/game'     # 找到已有 flow
pbmockx decode <id>                    # 查看字段树，拿到 path

# 2. 添加持久规则（pipe 规则由 rules.txt 自动注入，无需手写）
pbmockx rules add 'api/game' game.name 'MockedGame'
pbmockx rules add 'api/game' game.id 999

# 3. 用户重新触发请求 → 响应自动修改 → 客户端收到 mock 数据
#    不暂停、不超时 ✅

# 4. 验证
pbmockx flows --filter 'api/game'     # 抓到新 flow
pbmockx decode <new_id>               # patch 后: game.name=MockedGame
pbmockx decode <new_id> --original    # patch 前: game.name=TapTap (对比)
```

- **PB 和 JSON 行为完全一致** —— 都解码为 message/dict，按 path patch，
  再重新编码。区别只是 PB 的字段树有类型标注。
- `--protocol pb|json` 可选过滤（省略 = 同时应用两者）。
- 规则自动保存到 `rules.yaml`（重启后依然存在）。
- **pipe 规则由 `rules.txt` 自动注入** —— 只加 `rules add` 即可生效，
  无需在 whistle UI 里手写 `pipe://pbmockx` 规则。

### 2.2 Map Local — 替换整个响应 body

两种模式：

**Dict 模式（PB 增强，推荐用于 PB）：**
```
pbmockx map-local add '<url_regex>' --data '<json>'
  [--desc <url>] [--messageType <type>] [--delimited]
```
- 提供一个 JSON dict，pbmockx 用响应的 `desc` / `messageType`
  自动编码为 PB。
- 如果该 URL 之前被抓过，`desc` / `messageType` 从 flow_store 自动检测；
  否则必须显式提供 `--desc <url>` 和 `--messageType <type>`。
- `--delimited` 用于 multi-message PB 响应（编码为 JSON 数组）。
- dict 数据**保存到外部文件** `mock-data/<id>.json`（不在 rules.yaml 内），
  rules.yaml 只保存引用 `data_file: <id>.json`。

**File 模式（whistle 原生）：**
```
pbmockx map-local add '<url_regex>' --file <file_path>
```
- 使用 whistle 原生 `rawfile://` 规则 —— 本地文件的原始字节直接成为响应 body。
- 不会经过 PB 编码，适合你已经有现成 .pb / .json 文件的场景。

**管理：**
```
pbmockx map-local list
pbmockx map-local del <id>
```

### 2.3 Map Remote — 将请求重定向到另一个 URL（whistle 原生）
```
pbmockx map-local add '<url_regex>' <replacement> [--regex]
pbmockx map-remote list
pbmockx map-remote del <id>
```
- 使用 whistle 原生 `https://` 规则 —— 匹配的请求被重定向到 `<replacement>`。
- 整体 URL 模式：`<url_regex> → https://new.example.com/new`。
- 正则模式（`--regex`）：`re.sub(url_regex, replacement, url)` —— 灵活的部分替换。
- 适用于把测试环境请求指向 mock 服务器。

**第 4 步 — 执行：**
- **Patch 规则（推荐 —— 不暂停、不超时）：**
  ```
  # 1. 添加持久规则（pipe 规则由 rules.txt 自动注入，无需手写）
  pbmockx rules add '<url_regex>' <path> <value> [--protocol pb|json]
  # 2. 用户重新触发 → 响应自动修改 → 客户端收到 mock 数据
  ```
- Map Local：见 §2.2
- Map Remote：见 §2.3

**第 5 步 — 验证：**
```
pbmockx decode <id>              # 显示（mock 后的）字段树 / JSON
pbmockx decode <id> --original   # 显示原始（mock 前）数据用于对比
pbmockx rules list               # 确认规则生效
pbmockx rules list --type patch  # 按类型过滤
pbmockx rules list --type map_local
```
或让用户检查应用界面 / whistle Network 的 PBView sub-tab。

## 3. 命令参考

### 进程与连接
```
w2 start / stop / restart / status    # whistle 进程管理（不是 pbmockx start/stop）
w2 ca                                 # 安装 PC 根证书（打开证书页面）
pbmockx connect-android [-s <serial>] # 配置 Android 设备代理（adb reverse + http_proxy）
pbmockx web                           # 打开 whistle Web UI
```

### 抓包与查看
```
pbmockx flows [--filter <regex>]              # 列出 flow：id dir method status protocol messageType url
pbmockx decode <id> [--req|--res] [--original]  # 显示 headers + PB 字段树 / pretty JSON
```
> - **PB flow**：在 whistle UI 的 Network 里点开请求，切到 **Response → PBView**
>   sub-tab（响应）或 **Request → PBView** sub-tab（请求体）查看结构化字段树
>   （`name#N (type) = value`，未设置字段显示 `(unset)`，默认折叠点击 `▸` 展开）。
>   比 CLI 更直观，且支持点击展开任意层级。
> - **JSON flow**：PBView 显示 `JSON — use the Body tab`，请用 whistle 原生
>   Body tab 查看。CLI `decode <id>` 对 JSON flow 直接输出 pretty-JSON。
> - `decode <id>` 默认按 flow 方向显示（res→Response，req→Request）。
>   `--req` / `--res` 强制切换到匹配的请求 / 响应 flow（基于同 URL 关联）。
> - `decode <id> --original` 显示 patch 前的原始数据（与 patch 后对比验证）。
> - 所有子命令都有 `-h` / `--help`（例如 `pbmockx flows -h`、`pbmockx decode -h`）。

### 规则 — patch 类型（持久化、按路径）
```
pbmockx rules add <url_regex> <path> <value> [--protocol pb|json]
pbmockx rules list [--type patch|map_local|map_remote]
pbmockx rules del <id>
pbmockx rules save                    # 手动写回 rules.yaml
pbmockx rules reload                  # 从 rules.yaml 重新加载
```

### Map Local（body 替换）
```
pbmockx map-local add <url_regex> --data '<json>' [--desc <url>] [--messageType <type>] [--delimited]
pbmockx map-local add <url_regex> --file <file_path>    # whistle 原生 rawfile://
pbmockx map-local list
pbmockx map-local del <id>
```

### Map Remote（请求重定向，whistle 原生 https://）
```
pbmockx map-remote add <url_regex> <replacement> [--regex]
pbmockx map-remote list
pbmockx map-remote del <id>
```

### 工具维护
```
pbmockx doctor                        # 全链路健康检查（w2 + 插件 + npm link + 规则 + 流量）
pbmockx fix                           # 自动修复：rebuild（dist 缺失时）→ npm link → w2 restart → verify
pbmockx agent-doc                     # 打印本指南
pbmockx skill install                 # 安装到 agent skill 目录（~/.agents/skills/ + ~/.claude/skills/）
pbmockx version [--check]             # 显示版本；--check 查询 GitHub 最新版
```

## 4. path 与 value 语法
- **path**：用点号表示嵌套字段，用 `[n]` 表示列表索引。
  `game.name` · `items[0].id` · `data.list[0].list[0].brand.app.title`
- **value**：会先尝试按 JSON 解析 —— `int`（`100`）、`bool`（`true`/`false`）、
  `null`、对象（`{"k":"v"}`）、数组（`[1,2]`）。否则当作字符串处理。
  在 shell 中，字符串需加引号：`"hello"`。对象/数组用单引号包裹
  JSON：`'{"k":"v"}'`。
- path **区分大小写** —— proto 字段名是 snake_case（不是 camelCase）。

### ⚠️ PB 类型陷阱 —— v0.4.0 与旧版的关键差异

**v0.4.0 起，PB 数据不再被转换为 JSON** —— patch / map_local 直接作用于
protobufjs 的 message 对象（`decodeDelimited` → `set_by_path` →
`encodeDelimited`，**不经过 JSON 中转**），所以字段树展示与 patch 行为是
一致的：

- **int64/uint64 字段**：显示为 **数字**（不是字符串），带 `(int64)` 标注。
  - protobufjs 默认把 int64 当 JS `number`，超过 `Number.MAX_SAFE_INTEGER`
    才退化为 `Long.toString()` 字符串。
  - patch 时**传数字**：`pbmockx rules add url field 123`（不是 `"123"`）。
    字符串数字 `"123"` 经 `fromObject` 也会被强转为 number，但**非数字字符串
    如 `"sku1"` 仍会编码失败**。
- **enum 字段**：显示为 **数字 + 名字标注**，格式 `name#N (enum Status) = 1 (STATUS_ACTIVE)`。
  patch 时传**数字值**最稳妥（`fromObject` 也接受名字字符串，但传数字避免歧义）。
- **bytes 字段**：显示为 **base64 字符串**，带 `(bytes, NB)` 标注（B = 字节数）。
  patch 时传**合法的 base64 字符串**（不能用裸 bytes / number）。
- **google.protobuf.Any**：PBView / CLI 基于 `type_url` 自动解码内层 message，
  显示为 `name#N (Any → actual.Type)`，嵌套字段直接展开。**不要修改
  `@type` / `type_url`** —— 只修改其中嵌套的业务字段。
- **未设置的字段**：PBView 灰色显示 `(unset)`；CLI 显示 `name#N (type) (unset)`。
  patch 一个未设置的 scalar 字段会创建它；patch 一个 message 字段需要先有值。
- **务必检查 `patch_error`**：添加 patch 规则后，`decode <id>` 输出会带
  `patch_error`（如果编码失败，如类型不匹配）。修正值的类型后重试。
  示例：`patch_error: ... invalid literal for int() with base 10: 'sku1'`
  → 该字段是 int，你传了非数字字符串。

> 对比旧版（v0.3.0 mitmproxy）：PB 解码为 JSON 时 int64 会变成字符串、enum
> 会变成字符串名，存在歧义。v0.4.0 通过不转 JSON 直接消除了这些问题。

### pipe 规则（patch 生效的前提）
patch 规则只有在匹配请求经过 `pipe://pbmockx` 时才会执行。**插件加载时由
`whistle-plugin/rules.txt` 自动注入 `* pipe://pbmockx` 全量规则，默认所有请求
都走 pipe，无需用户手动配置。** 如需选择性 pipe，可在 whistle UI 的 Rules 里加
更具体的规则覆盖：
```
pattern: api/game      （比 * 更具体，只 pipe 匹配的请求）
operator: pipe://pbmockx
```
匹配的请求会走 pbmockx 的「自动解压 gzip/deflate/br → decode → patch →
encode」管道，返回**未压缩** body —— whistle 会自动处理 content-encoding
（剥除响应头里的 `content-encoding`），客户端和 Web UI 看到的都是 raw bytes。
其他流量不受影响。

## 5. 故障排查
- **`pbmockx doctor` 报 `w2: NOT running`**：运行 `w2 start`。若 `w2` 命令
  不存在 → 安装 whistle：`npm i -g whistle`。
- **`pbmockx doctor` 报 `plugin: NOT loaded` / `NOT REACHABLE` 或
  `npm link: NOT LINKED`**：插件未注册或 npm link 失效。直接运行
  `pbmockx fix`（自动 rebuild → npm link → w2 restart → verify health）。
  若仍未恢复，重新跑 `./scripts/install.sh`；修复前可用 `w2 exec pbmockx <cmd>`
  作为替代调用。
- **`flows` 一直为空 / `flow_count=0`**：见前置检查 —— 证书/代理/应用空闲。
  PC: `w2 ca` 安装证书；Android: `pbmockx connect-android`。
- **patch 规则不生效**：默认 `* pipe://pbmockx` 由 `rules.txt` 自动注入，
  无需手写 pipe 规则。如果你在 whistle UI 里改过 Rules（覆盖了 `*` 规则），
  确认对应 pattern 仍指向 `pipe://pbmockx`（§4 末尾）。同时检查 `url_regex`
  是否真的匹配请求 URL。
- **`decode` 返回 `error: "Couldn't find message X"`**：.desc 已加载但
  message X 的文件添加失败（缺少 google well-known 依赖）—— 这是
  插件 bug，请上报。或 `desc` URL 不可达 / `messageType` 错误：检查
  decode 输出中的 `content_type` 和 `desc` 字段。
- **`decode` 返回其他 `error`**：响应未被识别为 PB/JSON，或
  body 格式错误。检查 `content_type` —— PB 应为 `application/x-protobuf`
  或 JSON 应包含 `json`。
- **mock 没送达客户端**：v0.4.0 没有 breakpoint/intercept ——
  持续规则（patch + map_local）只对**添加规则之后**的新匹配响应生效。
  让用户重新触发请求即可。已经返回的旧 flow 不会被回改。
- **字段 path 错误 / IndexError**：重新运行 `decode <id>` 或看 whistle
  PBView sub-tab，从字段树里复制确切的 path。path 区分大小写。
- **mock 返回 400 "path not found"**：该 path 在解码数据中不存在。
  响应会带一个 `hint` 显示实际数据结构 —— 从中复制正确的 path。
- **map-local `--data` 模式失败**：编码 PB 需要 `desc` + `messageType`。
  如果该 URL 之前被抓过，会从 flow_store 自动检测。否则显式提供
  `--desc <url>` 和 `--messageType <name>`。
- **规则未持久化**：`rules add` 会自动保存到 rules.yaml。如果保存失败
  （权限/磁盘），手动运行 `pbmockx rules save`。用 `pbmockx rules list` 检查。
- **map_local data 文件丢失**：dict 模式数据存在 `mock-data/<id>.json`
  外部文件（不在 rules.yaml 内）。如果该文件被删，规则会失效 —— 重新
  `map-local add --data` 即可。

## 6. 备注
- 所有 CLI 命令通过插件 CGI API：
  `http://127.0.0.1:<whistle_port>/plugin.pbmockx/cgi-bin/...`。
  端口跟随 whistle 配置（默认 `http://127.0.0.1:8899`）。
- 持续规则在抓包时生效；`decode` 显示（可能已 mock 的）
  解码数据。用 `--original` 查看 mock 前的数据。
- PB `delimited=true` 响应解码为字段树数组；用 `[n]` 索引访问。
- flow_store 有 LRU 上限；满后淘汰最旧的。
- 所有规则类型（patch / map_local / map_remote）共用同一个 rules.yaml
  并可共存。每个匹配请求的执行顺序：
  map_remote(request，whistle 原生) → map_local(response，file 走原生 /
  data 走 pbmockx 编码) → patch(response，需 pipe://pbmockx)。
- 规则 ID 为 `crypto.randomBytes(4).toString('hex')`（8 字符 hex）。`rules.yaml` 启动时自动加载，add/del 时自动保存
  （保存时保留头部 `#` 注释和空行）。`rules.yaml` 被 `.gitignore` 排除
  （运行时生成），仓库内有 `rules.yaml.example` 作为模板。
