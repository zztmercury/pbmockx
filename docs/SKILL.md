---
name: pbmockx
description: 通过 mitmproxy 抓包并 mock protobuf（Charles 自描述规则）/ JSON 响应。addon 自动识别协议并解码为 dict；AI 按路径修补字段。支持 Charles 风格的 map local/remote/breakpoint。触发词：抓包、mock 数据、改接口返回、看 PB/JSON 响应、pbmockx、改 protobuf、改返回数据、造测试数据、map local、map remote、breakpoint。
---

# pbmockx — Agent 指南

一个 mitmproxy addon 会自动识别每个抓包 HTTP 响应的协议（protobuf 或 JSON），并解码为普通的 **dict/list**。你通过
`pbmockx` CLI 来操作它。**你永远不需要直接处理 protobuf wire 格式** —— 你按 `path` 读取/修改
dict 字段，就像编辑 JSON 一样。PB 和 JSON 在操作层完全一致。Web UI 可查看格式化 JSON（pbmockx view），编辑通过 CLI（`decode` + `mock`）。

## 1. 前置检查 — 每次首先执行

在做任何事之前，先运行 `pbmockx doctor`。它会检查整条链路：
Python / venv / CLI / skill / addon / 流量。解读结果：

| 结果 | 含义 | 操作 |
|---|---|---|
| addon: NOT running | mitmproxy 未运行 | 运行 `pbmockx start`（后台非阻塞 —— 启动 mitmdump，等待 control API，然后返回）。 |
| addon: OK, traffic: NO traffic | addon 已启动但没有流量 | 代理/证书未就绪 或 应用空闲。让用户操作应用（打开页面/搜索）触发流量，然后重新检查。如果应用有活动后流量仍为 0 → 证书未安装或设备代理未设置（指引：设备访问 http://mitm.it 安装 CA；Android 设备运行 `pbmockx connect-android` 配置代理）。 |
| addon: OK (flow_count=N>0) | 就绪 | 进入工作流 |

永远不要假设 mitmproxy 已在运行 —— 必须先用 `doctor` 验证。

## 2. 标准工作流 — 按此顺序执行

**第 1 步 — 找到目标 flow：**
```
pbmockx flows
```
输出：`<id>  METHOD STATUS [protocol] URL [paused] [ERR]`。记下你要 mock 的 flow 的 `id`（接受前 8 位）
和 `protocol`（`protobuf`/`json`）。
- 肉眼过滤：找到与你测试功能匹配的 URL 路径。
- `[protobuf]` = PB 接口（通过 Charles desc 规则解码）；`[json]` = JSON。
- `[paused]` = flow 被断点规则拦截 —— 等待你的操作。
- `ERR:...` = 该 flow 解码失败 —— 见故障排查。
- 用 `--filter <regex>` 缩小范围：`pbmockx flows --filter api/game`

**第 2 步 — 查看解码后的结构：**
```
pbmockx decode <id>
```
返回 `{protocol, messageType, desc, content_type, data: {...}}`。阅读 `data`
找到你想要修改的字段 `path`。PB 的 `data` 可能包含
`@type`（一个被展开为具体 message 的 google.protobuf.Any）—— 像普通嵌套 dict 一样进入它。
- 用 `--original` 查看应用任何 mock 规则之前的原始响应：
  `pbmockx decode <id> --original`

**第 3 步 — 决定 mock 方式：**

决策树（按优先级）：

1. **知道要改哪个字段？** → **Patch 规则**（`rules add`）—— 推荐。
   自动修改匹配的响应，不暂停、不超时。PB 和 JSON 都适用。
2. **需要替换整个响应 body？** → **Map Local**（`map-local add`）。
3. **需要把请求重定向到另一台服务器？** → **Map Remote**（`map-remote add`）。
4. **需要在运行时动态决定改什么？** → **Breakpoint**（`breakpoint add`）。
   ⚠️ 会暂停 flow —— 客户端等待。Agent 异步处理（LLM 推理每步约 2s）
   可能导致客户端超时。作为最后手段使用。

### 2.1 Patch — 按路径修改指定字段（推荐，不暂停、不超时）

**标准工作流（Agent 首选）：**
```
# 1. 先抓一个真实请求（或让用户触发一次）
pbmockx flows --filter 'api/game'     # 找到已有 flow
pbmockx decode <id>                    # 查看结构，拿到 path

# 2. 添加持久规则 —— 自动修改所有未来匹配的响应
pbmockx rules add 'api/game' game.name 'MockedGame'
pbmockx rules add 'api/game' game.id 999

# 3. 用户重新触发请求 → 响应自动修改 → 客户端收到 mock 数据
#    不暂停、不超时 ✅

# 4. 验证
pbmockx flows --filter 'api/game'     # 抓到新 flow
pbmockx decode <new_id>               # patch 后: game.name=MockedGame
pbmockx decode <new_id> --original    # patch 前: game.name=TapTap (对比)
```

- **PB 和 JSON 行为完全一致** —— 都解码为 dict，按 path patch，再重新编码。
- `--protocol pb|json` 可选过滤（省略 = 同时应用两者）。
- 规则自动保存到 `rules.yaml`（重启后依然存在）。
- 单次 `mock <id>` 也可用，但对已完成的 flow 不会送达客户端
  （用 `replay <id>` 重新投递，或改用 patch 规则）。

### 2.2 Map Local — 替换整个响应 body（Charles 风格）
```
pbmockx map-local add '<url_regex>' <file_path> [--status 200] [--header "K:V"]
pbmockx map-local add '<url_regex>' --data '<json>' [--desc <url>] [--messageType <name>] [--delimited]
```
- **File 模式**（兼容 Charles）：本地文件的原始字节成为响应 body。
- **Dict 模式**（PB 增强）：提供一个 JSON dict，用响应的
  `desc`/`messageType` 自动编码为 PB（从 flow_store 自动检测，或通过
  `--desc`/`--messageType` 指定）。这是相比 Charles 的关键优势 ——
  你永远不需要写 PB wire 格式。
- `--status` 覆盖 HTTP 状态码。`--header "K:V"` 新增/覆盖 header。

### 2.3 Map Remote — 将请求重定向到另一个 URL（Charles 风格）
```
pbmockx map-remote add '<url_regex>' <new_url>           # 整体 URL 替换
pbmockx map-remote add '<url_regex>' <replacement> --regex  # 正则部分替换
```
- 整体 URL 模式：匹配的请求被完整重定向到 `<new_url>`。
- 正则模式：`re.sub(url_regex, replacement, url)` —— 灵活的部分替换。
- 适用于把测试环境请求指向 mock 服务器。

### 2.4 Breakpoint — 按 URL 暂停（最后手段，⚠️ 可能超时）
```
pbmockx breakpoint add '<url_regex>'
```
- **⚠️ 超时风险**：breakpoint 会暂停 flow —— 客户端等待响应。
  Agent 异步处理（找到 flow → decode → mock → resume，每步 LLM 约 2s）
  可能超过客户端超时。**除非需要运行时动态决定的值，否则优先用 patch 规则（§2.1）。**
- **基于规则、持久**：添加一次，所有未来匹配的 flow 自动暂停。
- 与 `intercept on`（全局拦截所有请求）不同，breakpoint 规则
  只暂停匹配的 URL —— 其他流量正常通过。
- **已端到端验证**（暂停 → mock → resume → 客户端收到 mock 响应 ✅）。
- 完整交互流程：
  ```
  pbmockx breakpoint add 'api/game'         # 添加规则（持久）
  # 让用户在应用中触发请求
  pbmockx flows --paused                    # 找到被暂停的 flow
  pbmockx decode <id>                       # 查看当前数据
  pbmockx mock <id> game.name MockedGame     # 修改字段
  pbmockx resume <id>                       # 放行 → 客户端收到 mock 响应
  # 或: pbmockx abort <id>                  # 取消 → 客户端收到错误
  pbmockx breakpoint off                    # 结束后清除所有 breakpoint 规则
  ```
- `pbmockx breakpoint off` 清除所有 breakpoint 规则。

**第 4 步 — 执行：**
- **Patch 规则（推荐 —— 不暂停、不超时）：**
  ```
  pbmockx rules add '<url_regex>' <path> <value> [--protocol pb|json]
  # 用户重新触发 → 响应自动修改 → 客户端收到 mock 数据
  ```
- 通过 breakpoint 单次 patch（⚠️ 可能超时，见 §2.4）：
  ```
  pbmockx breakpoint add '<url_regex>'
  # 让用户在应用中触发请求
  pbmockx flows --paused   # 找到被暂停的 flow
  pbmockx mock <id> <path> <value>
  pbmockx resume <id>
  pbmockx breakpoint off   # 结束后清除
  ```
- 通过 intercept 单次 patch（⚠️ 会全局拦截所有流量）：
  ```
  pbmockx intercept on
  # 让用户在应用中触发请求
  pbmockx flows          # 找到新（被暂停）的 flow id
  pbmockx mock <id> <path> <value>
  pbmockx resume <id>
  pbmockx intercept off  # 结束后关闭
  ```
- Map Local：见 §2.2
- Map Remote：见 §2.3

**第 5 步 — 验证：**
```
pbmockx decode <id>              # 显示（mock 后的）解码数据
pbmockx decode <id> --original   # 显示原始（mock 前）数据用于对比
pbmockx rules list               # 确认规则生效
pbmockx rules list --type map_local   # 按类型过滤
```
或让用户检查应用界面。

## 3. 命令参考

### 抓包与 mock
```
pbmockx health                             # 快速检查 addon（ok + flow_count）
pbmockx doctor                             # 全链路健康检查
pbmockx flows [--filter <regex>] [--paused]  # 列出 flow + 协议 + 暂停标记
pbmockx flows clear                        # 清空所有已抓 flow
pbmockx decode <id> [--original]           # 完整解码 dict + 元信息
pbmockx mock <id> <path> <value>           # patch 单个 flow（单次）
pbmockx replay <id>                        # 重放一个 flow
pbmockx resume <id>                        # 放行被拦截/断点的 flow
pbmockx abort <id>                         # 终止 flow（向客户端发送错误）
pbmockx intercept on [--filter <expr>]     # 暂停所有匹配的 flow（全局）
pbmockx intercept off
```

### 规则 — patch 类型（持久化、按路径）
```
pbmockx rules add <url_regex> <path> <value> [--protocol pb|json]
pbmockx rules list [--type <type>]
pbmockx rules del <id>
pbmockx rules save                         # 手动写回 rules.yaml
pbmockx rules reload                       # 从 rules.yaml 重新加载
```

### Map Local（Charles 风格 body 替换）
```
pbmockx map-local add <url_regex> <file_path> [--status N] [--header "K:V"]
pbmockx map-local add <url_regex> --data '<json>' [--desc <url>] [--messageType <name>] [--delimited]
pbmockx map-local list
pbmockx map-local del <id>
```

### Map Remote（Charles 风格请求重定向）
```
pbmockx map-remote add <url_regex> <new_url> [--regex]
pbmockx map-remote list
pbmockx map-remote del <id>
```

### Breakpoint（Charles 风格按 URL 暂停）
```
pbmockx breakpoint add <url_regex>
pbmockx breakpoint list
pbmockx breakpoint del <id>
pbmockx breakpoint off                     # 清除所有 breakpoint
```

### 工具维护
```
pbmockx skill install [--agent opencode|claude|all] [--dir <path>]
pbmockx skill list
pbmockx skill uninstall [--agent <name>]
pbmockx update [--check]
pbmockx version
pbmockx start / stop / restart             # start: 后台 daemon，非阻塞
pbmockx connect-android [-s <serial>]     # 配置 Android 设备代理（adb reverse + http_proxy）
pbmockx agent-doc                          # 打印本指南
```

## 4. path 与 value 语法
- **path**：用点号表示嵌套字段，用 `[n]` 表示列表索引。
  `game.name` · `items[0].id` · `data.list[0].list[0].brand.app.title`
- **value**：会先尝试按 JSON 解析 —— `int`（`100`）、`bool`（`true`/`false`）、
  `null`、对象（`{"k":"v"}`）、数组（`[1,2]`）。否则当作字符串处理。
  在 shell 中，字符串需加引号：`"hello"`。对象/数组用单引号包裹
  JSON：`'{"k":"v"}'`。
- path **区分大小写** —— proto 字段名是 snake_case（不是 camelCase）。

### ⚠️ PB 类型陷阱 —— 解码后的 JSON 可能误导你
PB 解码为 JSON 时不保留精确的类型信息。常见陷阱：
- **int64/uint64 字段**：在解码 JSON 中显示为**字符串**（如 `"123"` 而非 `123`），
  因为 JSON Number 超过 2^53 会丢精度。patch 时传 `123`（int）或
  `"123"`（数字字符串）。传 `"sku1"`（非数字字符串）→ 编码失败。
- **enum 字段**：显示为**字符串名**（如 `"STATUS_ACTIVE"`）。patch 时传
  字符串名或数字值。
- **bytes 字段**：显示为 **base64 字符串**。patch 时传合法的 base64。
- **google.protobuf.Any**：含 `@type` 元数据字段。**不要修改 `@type`** ——
  只修改其中嵌套的业务字段。
- **务必检查 `patch_error`**：添加 patch 规则后，`decode <id>` 会显示
  `patch_error`（如果编码失败，如类型不匹配）。修正值的类型后重试。
  示例：`patch_error: re-encode failed: ... invalid literal for int() with base 10: 'sku1'`
  → 该字段需要 int，你传了非数字字符串。

## 5. 故障排查
- **`decode` 返回 `error: "Couldn't find message X"`**：.desc 已加载但
  message X 的文件添加失败（缺少 google well-known 依赖）—— 这是
  addon bug，请上报。或 `desc` URL 不可达 / `messageType` 错误：检查
  decode 输出中的 `content_type` 和 `desc` 字段。
- **`decode` 返回其他 `error`**：响应未被识别为 PB/JSON，或
  body 格式错误。检查 `content_type` —— PB 应为 `application/x-protobuf`
  或 JSON 应包含 `json`。
- **mock 没送达客户端**：单次 `mock` 只更新存储的
  flow。用 `intercept on`→`mock`→`resume`，或 `mock`+`replay`。持续规则
  只对添加规则之后的新匹配响应生效。
- **`flow_count` 一直为 0**：见前置检查 —— 证书/代理/应用空闲。
- **字段 path 错误 / IndexError**：重新运行 `decode <id>`，从
  dict 结构中复制确切的 path。path 区分大小写。
- **mock 返回 400 "path not found"**：该 path 在解码数据中不存在。
  响应会带一个 `hint` 显示实际数据结构 —— 从中复制正确的 path。
- **map-local dict 模式失败**：编码 PB 需要 `desc` + `messageType`。
  如果该 URL 之前被抓过，会从 flow_store 自动检测。否则显式提供
  `--desc <url>` 和 `--messageType <name>`。
- **breakpoint 一直阻塞**：breakpoint 规则是持久的 —— 会暂停
  所有未来匹配的 flow。结束后用 `pbmockx breakpoint off` 清除。
- **规则未持久化**：`rules add` 会自动保存到 rules.yaml。如果保存失败
  （权限/磁盘），手动运行 `pbmockx rules save`。用 `pbmockx rules list` 检查。

## 6. 备注
- Control API 默认地址：http://127.0.0.1:9090（可通过
  `PBMOCKX_HOST` / `PBMOCKX_PORT` 环境变量覆盖）。
- 持续规则在抓包时生效；`decode` 显示（可能已 mock 的）
  解码数据。用 `--original` 查看 mock 前的数据。
- PB `delimited=true` 响应解码为 JSON 数组；用 `[n]` 索引访问。
- flow_store 有 LRU 上限（500 个 flow）；满后淘汰最旧的。
- 所有规则类型（patch/map_local/map_remote/breakpoint）共用同一个 rules.yaml
  并可共存。每个请求的执行顺序：
  map_remote(request) → map_local(response) → breakpoint(response) → patch(response)。
