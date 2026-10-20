---
name: pbmockx
description: >
  pbmockx captures HTTP/HTTPS traffic and mocks protobuf/JSON API responses
  with a native proxy and web UI. Use when you need to: mock data, change API
  response fields, view protobuf responses, debug PB/JSON API calls, map local,
  map remote, patch response fields, capture HTTP traffic.
  Triggers: 抓包, mock数据, 改接口返回, 看PB/JSON响应, map local, map remote,
  patch, protobuf, 调试接口, 代理, pbmockx.
---

# pbmockx — Agent 指南

pbmockx 在本机运行一个**自带 MITM 代理 + Mock 引擎 + Web UI** 的守护进程，
自动识别 Charles 风格的自描述 protobuf：

```
Content-Type: application/x-protobuf; desc="http://host/Model.desc"; messageType="pkg.Msg"; delimited=true
```

**关键差异**：PB 响应不会被转换成 JSON。字段树直接来自 protobufjs message 对象，
显示为 `name#N (type) = value`（带字段号与类型），patch 也直接作用在 message 上。
这避免了 int64→string、enum→string 的歧义。

```
client / Android / curl ──proxy──► pbmockxd (:8899)
                                     ├─ 抓包（HTTP / HTTPS / WebSocket / SSE）
                                     ├─ Mock（patch / map_local / map_remote）
                                     ├─ 控制 API（CLI 使用）
                                     └─ Web UI（给人看：http://127.0.0.1:8899/）
```

- 进程管理：`pbmockx start/stop/restart/status`（**不是** w2）。
- PC/设备证书：`pbmockx ca`；Android：`pbmockx connect-android [-s <serial>]`。
- CLI 默认折叠输出、省 token；读命令支持 `--json`；所有命令支持 `-h/--help`。
- 规则持久化在 `~/.pbmockx/rules.yaml`，改完下一个请求立即生效（无需同步步骤）。

## 1. 前置检查 — 每次首先执行

```bash
pbmockx doctor
```

| 结果 | 含义 | 操作 |
|---|---|---|
| `daemon: FAIL` / `not running` | 代理守护进程没启动 | 运行 `pbmockx start`（后台 daemon，非阻塞）。 |
| `daemon: OK, flows: 0` + `traffic: WARN` | 没有流量 | 检查客户端代理是否指向 `127.0.0.1:8899`；HTTPS 还要信任 CA（`pbmockx ca`）。让用户触发一次请求。 |
| `CA: WARN` | CA 还没生成 | 运行一次 `pbmockx start` 或 `pbmockx ca`，然后按提示在各设备信任 CA。 |
| `legacy whistle: WARN` | 机器上还装着 whistle | 与 pbmockx 无关；如果它占用 8899，先 `w2 stop` 或给 pbmockx 换端口。 |
| `daemon: OK, flows: N>0` | 就绪 | 进入工作流。 |

**永远不要假设 daemon 在运行** —— 先用 `doctor` 验证。若 daemon 起不来：
`pbmockx fix`（重新构建 + 重启 + 健康检查），失败时看 `pbmockx logs -n 50`。

## 2. 标准工作流

### 第 1 步 — 找目标 flow

```bash
pbmockx flows
pbmockx flows --filter 'api/game'
pbmockx flows --json          # 机器可读
```

输出列：`id method status proto url`。同一 `id` 同时持有 request 和 response
（一条请求一行，没有 dir 列）。`proto` 是 `protobuf`/`json`（或 `req/res` 组合）。
`id` 形如 `1784529570691-003`，可以只取前 8 位。

### 第 2 步 — 查看解码结构

```bash
pbmockx decode <id>                          # Request + Response（默认折叠）
pbmockx decode <id> --req                    # 只看请求
pbmockx decode <id> --res                    # 只看响应
pbmockx decode <id> --path 'data.list[0]'    # 导航到子树（路径含 [n] 要加引号）
pbmockx decode <id> --full                   # 完整展开（不截断）
pbmockx decode <id> --original               # patch 前的原始响应
pbmockx decode <id> --original --path game   # 组合使用
pbmockx decode <id> --json                   # 原始 API detail（含字段树 JSON）
```

- 默认折叠：顶层 scalar 显示值；嵌套 message 显示 `(type, N fields)`；
  repeated 显示 `(repeated type, N items)`；长字符串截断到 80 字符。
- `--path`/`--full` 默认省略 method/url/headers（省 token）；加 `--headers` 找回。
- 字段树格式：`name#N (type) = value`。`#N` 是 **proto 字段号**，不是数组下标。
  enum 显示 `数字 (名字)`；bytes 显示 base64 截断 + 字节数；未设置显示 `(unset)`。
- `google.protobuf.Any` 显示 `name#N (Any → actual.Type)`，内层字段自动展开。
  **不要修改 `@type`/`type_url`**，只改内层业务字段。
- 人看 UI 更直观：`pbmockx web` 或 `http://127.0.0.1:8899/`，点 flow → 字段树，可展开任意层级。

### 第 3 步 — 选择 mock 方式

优先级：

1. **只改几个字段** → **patch**（`rules add`），推荐；不暂停、不超时。
2. **整体替换 response body** → **map local**（`map-local add`）。
3. **把请求转到另一台服务器** → **map remote**（`map-remote add`）。

> 没有 breakpoint/intercept。需要“运行时动态决定”时，用 patch + `pbmockx rules reload` 热更新。

## 3. Mock 规则

### 3.1 Patch — 按 path 改字段

```bash
pbmockx rules add '<url_regex>' <path> <value> [--protocol pb|json]
pbmockx rules add '<url_regex>' <path> --append <value>       # repeated 末尾追加
pbmockx rules add '<url_regex>' <path> --insert <idx> <value> # 插入到 index 前
pbmockx rules add '<url_regex>' <path> --remove <idx>         # 删除 index
pbmockx rules add '<url_regex>' <path> --unset                # 删除键
pbmockx rules list [--type patch|map_local|map_remote] [--json]
pbmockx rules del <id>
pbmockx rules save      # 手动写回 rules.yaml（add/del 已自动保存）
pbmockx rules reload    # 手动改过 rules.yaml 后重载
```

- `url` 是正则，对**完整 URL** 做 `RegExp.test`；非法正则回退子串匹配。
- `value` 先按 JSON 解析：`999` / `true` / `false` / `null` / `'{"k":"v"}'` / `'[1,2]'`；
  解析失败按字符串。
- `false` 与 `null` 会真实写入 body 并持久化（`0`/`''`/对象/数组同样）。
  **删除键用 `--unset`**：`null` = 键存在值为 null，`unset` = 键不存在。
- repeated 的条目级操作：`--append`/`--insert`/`--remove` 互斥；path 指向 repeated 字段本身
  （`items`，不要带 `[n]`），索引由 flag 提供。想改已有条目内部字段仍用普通 set：
  `rules add url 'items[0].name' NewName`。
- 规则按存储顺序执行；同 `url_pattern + type`（patch 还比 path）会替换旧规则。

**标准验证流程：**

```bash
pbmockx rules add 'api/game' game.name Mocked
# 让用户重新触发请求（旧 flow 不会被回改）
pbmockx flows --filter 'api/game'
pbmockx decode <new_id> --path game            # name=Mocked
pbmockx decode <new_id> --original --path game # patch 前
```

### 3.2 Map Local — 整 body 替换

```bash
# dict 模式：JSON 自动编码为 PB（PB 响应需要 desc/messageType）
pbmockx map-local add '<url_regex>' --data '{"game":{"name":"Mocked"}}' \
  [--desc <url>] [--messageType <type>] [--delimited] [--status 200]

# file 模式：本地文件原始字节直接作为响应
pbmockx map-local add '<url_regex>' --file /path/to/mock.pb [--status 200]

pbmockx map-local list
pbmockx map-local del <id>
```

- dict 数据保存在 `~/.pbmockx/mock-data/<id>.json`，rules.yaml 只存 `data_file`。
- 若规则没写 `desc`/`messageType`，会从该响应的 Content-Type 继承；
  响应本身也没有 PB 元数据时按 JSON 序列化兜底。
- `--status`/规则里的 `headers` 会覆盖响应状态与头。
- file 模式按扩展名推断 content-type（`.json`→json，`.pb/.bin`→protobuf/octet-stream）。

### 3.3 Map Remote — 请求重定向

```bash
pbmockx map-remote add '<url_regex>' '<replacement>' [--regex]
pbmockx map-remote list
pbmockx map-remote del <id>
```

- 非 regex：`replacement` 是完整目标 URL；**不带 scheme 时按 `https://` 处理**（兼容旧规则）。
- `--regex`：`url.replace(new RegExp(url_pattern), replacement)`（部分替换，`$1` 可用）。
- 例：`pbmockx map-remote add 'pub\.xdrnd\.cn/api/x' '127.0.0.1:9101/api/x'`
  → 请求发到 `https://127.0.0.1:9101/api/x`，Host/SNI 同步改写。
- 指向 loopback/私网的 HTTPS 目标会自动跳过上游证书校验（方便本地 mock server）。

### 3.4 执行顺序

```
map_remote(请求阶段) → map_local(file)(请求阶段) → map_local(data)(响应阶段) → patch(响应阶段)
```

请求阶段规则先决定目标/本地响应；响应阶段规则只在响应是 JSON/PB 且非 SSE 时执行。
`map_local(file)` 命中时不会访问上游；`map_remote` 改写的目标仍会抓包记录。

## 4. 命令参考

### 进程与连接

```bash
pbmockx start [--port 8899] [--host 127.0.0.1] [--foreground]
pbmockx stop | restart | status [--json]
pbmockx logs [-f] [-n 100]
pbmockx web                                   # 打开 Web UI
pbmockx ca [--out <file>] [--info] [--regen --yes]
pbmockx connect-android [-s <serial>]
```

- 默认监听 `127.0.0.1:8899`；需要局域网设备访问时 `--host 0.0.0.0`（管理 API/UI 仍只限 loopback）。
- 端口占用时用 `PBMOCKX_PORT=8900 pbmockx start`；CLI 后续命令会自动从 `runtime.json` 找到端口。
- Android：`connect-android` 会执行 `adb reverse tcp:8899 tcp:8899` + `settings put global http_proxy 127.0.0.1:8899`，并检测 CA 状态（system/user/not_found/unknown；非 root 设备用户证书目录受 SELinux 保护，通常 unknown，需要手动核对）。

### 抓包与查看

```bash
pbmockx flows [--filter <regex>] [--json]
pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full] [--headers] [--json]
```

### 工具维护

```bash
pbmockx doctor [--json]      # Node / 数据目录 / CA / daemon / 规则 / 流量
pbmockx fix                  # 构建 + 重启 + 验证
pbmockx agent-doc            # 打印本指南
pbmockx skill install|list|uninstall
pbmockx version [--check]
```

## 5. Path 与 value 语法

- **path**：点号嵌套，`[n]` 列表索引：`game.name`、`items[0].id`、
  `data.value.list[0].app.title`（`data` 是 Any 时自动穿透）。区分大小写，
  proto 字段名是 snake_case。
- **value**：先 JSON 解析，再字符串兜底；shell 中对象/数组用单引号包 JSON。
- PB 类型：
  - **int64/uint64**：传数字（`123`）；非数字字符串会 encode 失败。
  - **enum**：传数字最稳（也接受名字字符串）。
  - **bytes**：传合法 base64 字符串。
  - **未设置字段**：patch scalar 会创建它；patch message 字段需要先有值。
- 加规则后检查 `patch_error`：`decode` 输出末尾或 `--json` 的 `patchError` 字段。
  例如 int 字段传了 `sku1` 会报编码错误。

## 6. 故障排查

| 现象 | 排查/处理 |
|---|---|
| `flows` 一直为空 | `pbmockx doctor`；确认客户端代理指向 `127.0.0.1:8899`；HTTPS 要信任 CA（`pbmockx ca` 看说明，Android 用 `connect-android`）。 |
| HTTPS 请求报证书错误 | 客户端没信任 pbmockx CA。下载 `http://127.0.0.1:8899/__pbmockx/api/ca.pem` 并安装；Android 7+ 需系统证书或 networkSecurityConfig。 |
| patch 不生效 | 检查 `url_pattern` 是否匹配完整 URL（`pbmockx flows` 里的 `url`）；确认响应 `proto` 是 protobuf/json（非 SSE/HTML）；规则是否被 `enabled:false` 关闭（UI 可看）；`pbmockx rules list`。 |
| `decode` 报 `Couldn't find message X` | `.desc` 缺少依赖或 `messageType` 写错；检查响应 Content-Type 的 `desc`/`messageType`。 |
| `patch_error` / 编码失败 | value 类型不匹配（int64 传了非数字、bytes 不是 base64、enum 名字不存在）。改成正确类型后重试。 |
| map_local(data) 失败 | 该响应 Content-Type 没有 `desc`/`messageType`；给规则显式加 `--desc`/`--messageType`。 |
| 大响应 body 变短 | 超过 `maxRecordBodyBytes` 会被记录截断（详情会提示 truncated），但客户端收到的字节不受影响；改写超过 `maxRewriteBodyBytes` 会放弃 mock 并透传。 |
| 请求一直卡住 | 见 `pbmockx logs -n 100`；确认上游可达；h2-only/gRPC 接口不支持（用 bypass 原始隧道）。 |
| 规则未持久化 | `rules add/del` 自动保存；手动改文件后 `pbmockx rules reload`；`pbmockx rules list` 核对。 |
| daemon 起不来 | `pbmockx fix`；仍失败看 `pbmockx logs -n 50`；端口冲突换 `PBMOCKX_PORT`。 |

## 7. 备注与限制

- 支持 HTTP/1.1 代理、HTTPS CONNECT MITM、gzip/deflate/br、SSE、WebSocket 隧道。
- **不支持 HTTP/2 / gRPC**（MITM 只提供 `http/1.1`，上游统一 h1）；纯 h2/gRPC 请加到 `proxy.bypass` 走原始隧道。
- 无 breakpoint/intercept；所有修改用持续规则。
- flow 存在内存（LRU + 总字节上限），重启后清空。
- 规则、mock 数据、CA、日志都在 `~/.pbmockx/`（`PBMOCKX_DATA_DIR` 可覆盖）。
- 规则 ID 是 8 位 hex；`rules.yaml` 与旧 whistle 插件格式兼容（新增可选 `enabled`）。
- 给人看的 UI：`pbmockx web`；给 agent 的机器输出：`--json`。
