# AGENTS.md — pbmockx 开发指南

面向 Agent 的高信噪比上下文。用户使用指南在 `skill/SKILL.md`（`pbmockx agent-doc` 打印）——本文件只覆盖开发者关注点。

## 架构

单一 Node.js 守护进程（`pbmockxd`）同时承担代理、Mock、控制 API 和 Web UI，**不再依赖 whistle**。

```
pbmockx CLI ──HTTP──► pbmockxd :8899
                        ├─ /__pbmockx/api/*   控制 API（默认 loopback，可开放 LAN）
                        ├─ /                  静态 Web UI（web/）
                        ├─ CONNECT / 绝对 URL  正向代理 + TLS MITM
                        ├─ mock engine（rules.yaml + mock-data/）
                        └─ flow store（内存 LRU + 总字节预算）
client / Android / curl ──proxy──► pbmockxd ──► upstream
```

- 入口：`bin/pbmockx.js`（CLI → `dist/src/cli/index`）、`bin/pbmockxd.js`（前台守护进程 → `dist/src/server/daemon`）。
- 单端口路由优先级（`src/server/daemon.ts`）：`CONNECT` → 绝对 URL（代理）→ 本机 origin-form（API/UI；loopback/LAN IP/hostname）→ 其余 origin-form（按 Host 转发）。
- 默认绑定 loopback。绑定 `0.0.0.0`/`--lan` 后，代理、UI、控制 API 都可从 LAN 访问；`ui.lanAccess=false` 时非 loopback 只能访问代理和 CA 下载端点。
- 本地请求判定用 `isLocalHostname()`（loopback / 本机网卡 IPv4 / hostname / hostname.local）；不要只判断 `127.0.0.1`，否则 LAN 打开 UI 会被当成代理目标。
- 端口默认 8899（兼容旧 Android `adb reverse`/系统代理配置）；`PBMOCKX_PORT` / `config.json` 可改。
- 所有可写运行时状态都在数据目录 `~/.pbmockx`（`PBMOCKX_DATA_DIR` 可覆盖）；代码目录只读。

## 目录

```
src/core/     pb-engine, desc-cache, field-tree, path-nav, any-expand,
              content-type, rules, flow-store, flow-view, http-body, config, logger
src/proxy/    ca.ts（根 CA + 叶子证书）、proxy.ts（代理/MITM/WS/转发）
src/mock/     engine.ts（请求阶段 map_remote/map_local(file)；响应阶段 patch/map_local(data)）
src/server/   daemon.ts（启动/生命周期）、control-api.ts、static.ts、events.ts
src/cli/      index.ts（分发/命令）、api.ts、lifecycle.ts、render.ts、args.ts、android.ts、help.ts
web/          index.html, styles.css, app.js, tree.js, panels.js, api.js（零构建 ES Modules）
tests/        unit/、e2e/、helpers.ts、fixtures/
skill/SKILL.md  唯一面向用户的 agent 指南（`agent-doc` 打印）
```

## 运行时数据

```
~/.pbmockx/
├─ config.json      可选配置（端口/host/代理/抓包上限）
├─ runtime.json     {pid,port,host,version,startedAt,dataDir}；CLI 用它找端口
├─ rules.yaml       规则（启动加载，add/del 自动保存；只过滤 undefined）
├─ mock-data/       map_local(data) 的 <id>.json
├─ ca/              ca.pem、ca.key(0600)、leaf.key(0600)
├─ desc-cache/      .desc 条件请求缓存 + index.json
└─ logs/pbmockxd.log
```

- **规则防清空**：`RuleEngine.save()` 在未成功读过磁盘前拒绝写入（`initialized` 标志）。不要在构造函数里绕过它。
- **legacy 导入**：仅在默认数据目录且未显式设置 `PBMOCKX_DATA_DIR` 时，从 `<root>/whistle-plugin/rules.yaml` 等候选路径一次性复制旧规则与 mock 数据。测试/`--data-dir` 必须保持干净。
- **数据目录迁移**：不要写代码目录下的 `rules.yaml`；所有路径走 `src/core/config.ts:paths()`。

## 规则模型（rules.yaml）

`RuleEngine`（`src/core/rules.ts`）字段与旧版兼容，新增可选 `enabled`（默认 true；`toDict` 只在 false 时写出）。

| type | 阶段 | 关键字段 | 行为 |
|---|---|---|---|
| `patch` | response | `path`,`value`,`protocol`,`action`(set/append/insert/remove/unset),`index` | 在 PB message / JSON 对象上按 path 改字段；PB path 可穿透 `Any`（先 `expandAny` 再 patch 再 `packAny`） |
| `map_local`(data) | response | `data_file`/`data`,`desc`,`messageType`,`delimited`,`status`,`headers` | 整 body 替换；缺 desc/messageType 时从响应 Content-Type 继承；PB encode 或 JSON stringify |
| `map_local`(file) | request | `file_path`,`status`,`headers` | 直接返回本地文件字节，不访问上游；按扩展名推断 content-type |
| `map_remote` | request | `replacement`,`is_regex` | 改写目标 URL；replacement 无 scheme 时补 `https://`（whistle 兼容）；同步 Host/SNI |

- **执行顺序**：请求阶段 `map_remote`（首个命中）→ `map_local(file)`（首个命中）；响应阶段按存储顺序依次执行 `map_local(data)` / `patch`。
- **匹配**：`new RegExp(url_pattern).test(url)`；非法正则回退子串 `includes`。`protocol` 字段存在时只对对应响应协议生效。
- **value 语义**：`toDict()` 只过滤 `undefined`——`false`/`null`/`0`/`''` 真实写入并持久化；删除键用 `action: unset`（`null` ≠ `unset`）。
- **错误**：任何 patch/encode/decode 失败都返回原始 body 并把原因写进 `patchError`/`decodeError`；绝不返回半截/半改响应。
- **去重**：`add()` 对同 `url_pattern + type` 替换（patch 还比较 `path`）；规则 ID 是 8 位 hex。

## 抓包流水线（src/proxy/proxy.ts）

- **请求**：立即建 flow 记录（id `${Date.now()}-${三位序号}`）→ 请求阶段规则 → 本地响应或流式转发上游。请求体旁路采样（cap），永不因 mock 阻塞。
- **响应**：记录状态/头/首字节 → 仅当 Content-Type 为 JSON/PB、非 SSE、非 HEAD/204/304 且存在响应阶段规则时才 `collectBody`。否则 `pipe` 透传 + 旁路采样。
- **改写**：解压（gzip/deflate/br，按编码链逆序）→ `detect`（desc/messageType 来自 Content-Type）→ 解码 → `expandAny` → 规则 → `packAny` → 编码 → 按原编码重新压缩（失败则丢弃 `content-encoding`）→ 修正 `content-length` → 下发。原始未压缩 body 存 `resOriginalBody` 供 `--original`/UI 对比。
- **不缓冲**：SSE（`text/event-stream`）和超 `capture.maxRewriteBodyBytes` 的响应直接流式透传；记录侧 `maxRecordBodyBytes` 截断并标记 `truncated`。
- **头部**：请求转发剥离 hop-by-hop（`connection`/`keep-alive`/`proxy-*`/`te`/`trailer`/`transfer-encoding`/`upgrade`）并重写 `Host`；响应剥离 hop-by-hop，改写时删旧 `content-length`。`set-cookie` 数组保留。
- **上游 TLS**：默认校验；目标为 loopback/私网或全局关闭时跳过校验（本地 HTTPS mock server 场景）。上游 HTTP/1.1。
- **WebSocket**：外层与 MITM 内层都监听 `upgrade`，手工发 upgrade 握手并双向 pipe；只记录 101/字节数，不解析帧。
- **自环**：目标是本机同端口时返回 421，避免代理递归。

## CA / TLS MITM（src/proxy/ca.ts）

- 首次启动生成根 CA（RSA 2048、SHA-256、10 年、`CA:TRUE`，私钥 0600）；叶子证书复用一张常驻 `leaf.key`，按 CONNECT host 签发并内存缓存，SAN 覆盖 DNS/IP。
- CONNECT 流程：`ca.getLeafPems(host)` → 回 `200 Connection Established` → `socket.unshift(head)`（客户端可能已发 ClientHello）→ 每连接一个 `tls.createServer({key,cert,ALPNProtocols:['http/1.1']})` → `tlsServer.emit('connection', socket)` → 握手完成后 `innerHttpServer.emit('connection', tlsSocket)`。
- **ALPN 只提供 `http/1.1`**：主流客户端会降级；gRPC/纯 h2 不支持，走 bypass 原始隧道。
- **只对 `proxy.mitmPorts`（默认 443/8443）做 MITM**；空数组 = 所有端口（测试用）。bypass 列表支持 `*.example.com`/`.example.com`/子域匹配。
- **不要给 IP 设置 `servername`**：Node `https.request`/`tls.connect` 会报 “Setting the TLS ServerName to an IP address is not permitted”。代码用 `isIpLiteral()` 判断。
- `cert.sign()` 必须用 CA key；`getLeafPems` 有并发单飞去重。CA 重新生成后旧叶子缓存必须清空（`regenerate()` 已处理）。

## Flow / API

- `FlowStore` 同时按条数（`capture.maxFlows`）和总 body 字节（`capture.maxTotalRecordBytes`）淘汰；`upsert` merge 请求与响应，`rev` 自增用于详情缓存失效。
- `FlowRecord` 主体字段见 `src/core/flow-store.ts`；`resBody` 是 patch 后（未压缩），`resOriginalBody` 是 patch 前；`resInfo` 保存 desc/messageType/delimited。
- API 响应形状尽量 1:1 沿用旧 CGI，CLI 依赖：`/health`、`/flows`、`/flows/:id?original=1`、`/rules`、`/map-local`、`/ca.pem`、`/events`。详见 `src/server/control-api.ts`。
- 字段树由服务端 `buildFieldTree` 构建（PB）并按 `id:rev:original` 缓存 200 条；JSON/form 在 API 层解析。
- SSE 事件：`flow.new` / `flow.update` / `rules.changed`；`EventHub` 每 15s ping。
- `/cgi-bin/rootca` 与 `/cgi-bin/health` 是兼容别名。

## CLI

- `src/cli/index.ts` 手写 argv 分发；`args.ts` 保留 `rules add` 的历史解析（含 `_parseRulesAddArgs`/`_buildPatchRule`/`_parseValue` 旧名）。
- 输出契约：`flows` 列 `id method status proto url`；`decode` 的 `=== Request/Response ===`、折叠字段树、`--path/--full/--original/--headers` 行为与旧版一致；`rules list` 列 `id type url path value`。
- 所有读命令支持 `--json`；新增 `start/stop/restart/status/logs/ca`。
- `--data-dir <dir>` 是全局参数：`main()` 在分发前把它转成 `PBMOCKX_DATA_DIR` 并移除，测试/多实例都用它。
- `doctor` 只做检查（退出码 0）；`fix` = `tsc` → restart → health verify。
- 进程管理：`start` detached spawn `bin/pbmockxd.js`，日志重定向到数据目录；等待 health；`stop` SIGTERM→SIGKILL；`runtime.json` 是 CLI 找端口的权威来源。CLI 的 API host 用 `resolveHost()`（runtime 里非通配地址优先），支持 `--host <LAN-IP>` 这种非 loopback 绑定。
- `--lan` = `host=0.0.0.0` + `ui.lanAccess=true`；普通 `--host 0.0.0.0` 也默认允许 LAN UI（config 可关）。`connect-android --wifi` 用 LAN IP 替代 adb reverse。
- `connect-android`：`adb reverse tcp:<port> tcp:<port>` + `settings put global http_proxy`；证书状态复用 `android.ts` 的纯函数（system/user/not_found/unknown）。

## Web UI（web/）

- 零构建原生 ES Modules；由 `src/server/static.ts` 从 `web/` 提供。不要引入 CDN 或打包器。
- `app.js`：状态、flow 列表/详情、SSE、抽屉/弹窗、快捷键；`tree.js`：PB/JSON 懒加载树；`panels.js`：规则与 CA/setup 面板；`api.js`：`/__pbmockx/api` fetch 封装。
- flow 列表有 Flat/Tree 两种视图：Tree 用压缩路径 trie（host → 共享路径前缀 → 请求），默认全部折叠（只显示 host 分组），展开状态存 `pbmockx-tree-open-v2`；选中的请求会给其祖先分组加 `has-selected` 标记。列表宽度可拖拽（`--sidebar-width`，双击复位）。
- 大响应注意懒加载：树节点只在首次展开时构建 DOM；raw/hex 视图限 64KB/400KB 显示。
- 安全：`static.ts` 下发 CSP（self + inline style），无外链/CDN；管理面访问控制（loopback / `ui.lanAccess` / CA 下载例外）在 daemon 层。

## 测试

```bash
npm run typecheck
npm test                 # tsc + node --test dist/tests/
node --test --test-name-pattern "WebSocket" dist/tests/e2e/http.test.js
```

- `tests/unit/core.test.ts`：PB 引擎/路径/规则/字段树/协议识别/CLI 参数/Android 纯函数（40 条）。
- `tests/unit/support.test.ts`：FlowStore 边界、压缩、header、CA、MockEngine、config。
- `tests/e2e/http.test.ts`：HTTP 抓包、patch、gzip、map-local/map-remote、SSE、2MB 透传、HEAD/204、WebSocket、CLI 契约。
- `tests/e2e/https.test.ts`：CONNECT MITM、HTTPS patch、CA 端点。
- `tests/e2e/pb.test.ts`：PB 字段树、patch + original、patch_error 回退。
- **测试陷阱**：daemon 与测试同进程时，**不要用 `spawnSync` 调 CLI**（阻塞事件循环导致 CLI 等不到 daemon）；用异步 `spawn`。上游服务器 close 时要 `closeAllConnections()`（upgrade socket 不会被 close 等待）。
- 集成测试用 `tests/helpers.ts`：临时数据目录、随机端口、上游 HTTP/HTTPS、CONNECT 客户端、`jsonApi`。

## 开发环境注意

- **安装脚本**：`scripts/install.sh` 支持 `PBMOCKX_REF` / `--ref <branch>`；远程代码在 `~/.pbmockx/app`，数据在 `~/.pbmockx`；会替换旧的 `whistle.pbmockx` 全局链接，`--uninstall --purge` 清理数据。
- **npm 缓存**：沙箱/权限异常时用 `npm install --cache .npm-cache`（已 gitignore）。
- **数据目录**：测试/本地开发用 `PBMOCKX_DATA_DIR=$PWD/.dev-data` 或 `--data-dir`，避免写 `~/.pbmockx`。
- **局域网测试**：`0.0.0.0` 绑定后用本机 LAN IP 访问 UI/API 可模拟非 loopback 来源；`ui.lanAccess=false` 应返回 403（CA 下载端点除外）。
- 运行时依赖只有 `protobufjs`、`long`、`js-yaml`、`node-forge`；不要重新引入 koa/whistle。
- Node ≥ 18（`node:test` 可用）；TypeScript 不开 strict，编译到 `dist/`。
- 无测试框架，使用 `node:test` + `assert`；测试文件编译后由 `node --test dist/tests/` 执行。

## 关键陷阱

1. **`servername` 不能是 IP**（见上）；IPv6 地址要先用 `stripBrackets()` 去掉 `[ ]` 再用于 `net.connect`/`https.request`（`target.host` 仍保留方括号作为 Host 头）。
2. **`Expect: 100-continue`** 交给 Node 处理；不要吞掉请求体。
3. **改写后必须删旧 `content-length`**，否则客户端截断；压缩失败要删 `content-encoding`。
4. **SSE 绝不能 buffer**：即使有 patch 规则也不改写（`needsMock` 排除 `isEventStream`）。
5. **大 body**：记录 cap 与改写 cap 分离；记录截断要标记，详情解码时提示。
6. **patch 失败回退**：`MockEngine.transformResponse` 返回 `{patched:false, patchError}`，代理必须发原始字节。
7. **规则保存**：不要在未 reload 的情况下调用 `save()`，否则可能覆盖磁盘规则（已有守卫，勿移除）。
8. **CA 私钥权限 0600**；`pbmockx ca --regen` 需要 `--yes` 并重启 daemon。
9. **管理面访问控制**：默认只允许 loopback；绑定 LAN 且 `ui.lanAccess=true` 时允许非 loopback（CA 下载端点始终允许）。`isLocalRequest` 负责区分本机 UI 与代理流量，remoteAddress 负责鉴权，两者不要混淆。
10. **单端口自环**：目标是自身端口时返回 421/UI，不能递归代理。
11. **请求体旁路采样必须在 pipe 同一 tick 开始**：不要在 `await planRequest()` 前 `req.on('data')` —— 那会让流进入 flowing 模式，body 在真正 pipe 到上游前被丢弃（POST 变空）。`startRequestTap()` 就是为此延后调用。

## 发版

```bash
echo "1.0.0" > VERSION
# 同步 package.json 的 version
# 更新 CHANGELOG.md
git add VERSION package.json CHANGELOG.md && git commit -m "release: v1.0.0"
git tag v1.0.0 && git push && git push --tags
gh release create v1.0.0 --notes-file CHANGELOG.md --title "v1.0.0"
```

`VERSION` 是权威版本来源；`pbmockx version` 读取它，`doctor`/UI 显示它。`version --check` 非阻塞请求 GitHub releases。
