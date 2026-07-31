# Changelog

所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-07-31

### 新增
- **PBView 夜间模式**：CSS 变量化 + `prefers-color-scheme: dark` 自动跟随系统主题，`color-scheme` meta 适配原生控件；`html` 背景填满窗口（覆盖 whistle tab.html 注入的白色背景）。
- **connect-android 证书检测**：运行时用 node-forge 计算 `subject_hash_old`（whistle CA 的 CN 含时间戳每台不同，不能硬编码），检测系统证书区（`/apex/com.android.conscrypt/cacerts` + `/system/etc/security/cacerts`，含 Magisk 注入）和用户证书区（`/data/misc/user/0/cacerts-added` + `/data/misc/keychain/cacerts-added`），输出状态 `system`/`user`/`not_found`/`unknown`。非 root 设备两区都可读。
  - 防误导输出：明确区分 Step1（已执行 `[exec]`）vs Step2（只读检测），`unknown` 表示无法判定（权限拒绝/离线）绝不报"未安装"；`user` 状态警告 Android 7+ app 默认不信任用户证书（需 root/Magisk 装系统证书或 app 配 networkSecurityConfig）。
  - 前置设备检查：不带 `-s` 时 `adb devices` 解析，0 设备 / >1 设备（含 offline）/ 单设备非 device 状态三种情况中断 + 正确提示。
  - 代理生效验证：`settings get global http_proxy` 检测代理状态（ok/mismatch/unset）。
- **Form 表单请求体解析**（`application/x-www-form-urlencoded`）：pipe hook 识别 form content-type，`parseForm` 用 `URLSearchParams` 解析（同名 key 合并数组），存入 flowStore 供展示，请求体原样透传不修改（不做 patch）。CLI `decode --req` 以 K=V 对齐渲染。不支持 multipart（whistle WebUI 自带 WebForms 展示）。

### 变更
- **PBView 重构为共享外部 JS**：`pb-req.html`/`pb-res.html`（174→82 行）+ 共享 `pb-view.js`（IIFE 原样提取），消除两文件 100% 重复的 CSS+JS。外部 JS 用相对路径 `<script src="pb-view.js">` 加载（whistle 把 `/plugin.pbmockx/public/x` 请求剥前缀转发给插件 uiServer 的 `/public/:filename` 路由 serve）。
- **修复 PUBLIC_DIR 路径 bug**：`router.ts` `PUBLIC_DIR` 多算一层 `..`（4→3，指向 `whistle-plugin/public`），这是 AGENTS.md 误记"外部 JS 不能加载"的真实原因（非 whistle 机制限制）。
- **新增 node-forge 依赖**：用于 Android 证书 subject hash 计算（纯 JS，与 openssl `subject_hash_old` 实测一致）。
- **单测增强**：13→20 个（+form×3 / cert×3 / parseDevices×1），新增 cert 测试 fixture（`tests/fixtures/test-cert.pem`）。
- **文档同步**：SKILL.md connect-android 措辞防误导（"不要假设证书未安装，用此命令检测"）；AGENTS.md 修正"外部 JS 无法加载"过时表述 + pb-view.js 重建 + connect-android 检测 + PUBLIC_DIR 说明。

## [0.4.1] - 2026-07-27

### 修复
- **skill install 路径错误**：旧版把 `SKILL.md` 文件 symlink 到 `~/.agents/skills/pbmockx`（无扩展名文件），导致 agent 期望的 `~/.agents/skills/pbmockx/SKILL.md` 路径不存在、读不到文档。改为 symlink 整个 `skill/` 目录到 agent skill 目录，`pbmockx/SKILL.md` 正确命中；未来加 `_assets/` 等资源文件也自动覆盖。
- 移除 install 的 copy 兜底分支（symlink 失败直接报错，按需手动处理）。

### 新增
- **doctor 检测 skill 安装状态**：检查 `~/.agents/skills/pbmockx` 和 `~/.claude/skills/pbmockx`，区分 OK / BROKEN（symlink 断链）/ NOT INSTALLED / NOT SYMLINK，给出修复命令提示。

### 变更
- 文档目录迁移 `docs/SKILL.md` → `skill/SKILL.md`（独立 skill 目录，便于整体 symlink + 承载资源文件）。

## [0.4.0] - 2026-07-20

### 重大变更 — 迁移到 whistle 插件

从 mitmproxy Python addon 迁移到 whistle Node.js 插件，解决 mitmweb 查看 PB/JSON 数据交互体验差的问题。

### 新增
- **whistle.pbmockx 插件**（`whistle-plugin/`）：Node.js/TypeScript，运行在 whistle 进程内
  - **pipe hooks**（resRead/reqRead）：decode→patch→encode 单向处理，自动解压 gzip/deflate/br（按 `content-encoding` 调用 `zlib.gunzipSync`/`inflateSync`/`brotliDecompressSync`，encode 后返回未压缩 body，whistle 自动剥离 content-encoding）
  - **Any 展开/回包**（`src/any-expand.ts`）：patch 前 `expandAny` 按 `type_url` 解码 `google.protobuf.Any` 的 value bytes 为内层 message，patch path 可穿透 Any 字段导航到内层业务字段（如 `data.value.list[0].app.title`，`data` 是 Any，`value` 是内层 message），patch 后 `packAny` 重新编码为 bytes 包回 Any
  - **PBView 子标签页**：Request/Response 区各注入一个 PBView 子标签页，展示 PB 字段树
    - 格式 `name#N (type) = value`，带字段号、类型标注
    - `google.protobuf.Any` 按 `type_url` 嵌套解码
    - 未设置字段显示 `(unset)`，默认折叠
  - **rulesServer hook**：map_remote / map_local(file) 自动翻译为 whistle 原生规则
  - **uiServer**（Koa）：CGI API 供 CLI 和 PBView 调用
- **PB 引擎用 protobufjs 重写**：`Root.fromDescriptor` 动态加载，`long` 库处理 int64 精度，不转 JSON（直接操作 message 对象，避免 int64→string / enum→string 歧义）
- **Node.js CLI**（`bin/cli.js`）：所有命令支持 `-h`/`--help`，`decode <id>` 显示 headers + 字段树
  - `decode` **默认折叠模式**（节省 token，适合 AI agent）：顶层 scalar 显示值，嵌套 message 显示 `(type, N fields) ▸`，repeated 显示 `(repeated type, N items) ▸`，长字符串截断到 80 字符加 `...`
  - `--req` / `--res`：只看 Request 或 Response（**同一 flow**，不是找另一个 flow）
  - `--original`：显示 patch 前原始数据（可与 `--path` / `--full` 组合）
  - `--path <path>`：导航到子树（折叠显示），路径含 `[n]` 需加引号
  - `--full`：完整展开所有层级（不截断，旧版默认行为）
- **flow_store 合并 REQ/RES 双 ID**：同一个 whistle session ID（如 `1784529570691-003`）同时持有 request 和 response 数据。reqRead 上报时 upsert 到 `req` 字段，resRead 上报时 upsert 到 `res` 字段，不创建新条目。`flows` 列表每条请求一行（无 `dir` 列），`decode <id>` 同一 ID 同时显示 Request 和 Response。
- **`pbmockx fix` 命令**：自动修复插件安装——rebuild（dist 缺失时跑 `npm install` + `tsc`）→ npm link → w2 restart 加载插件 + rules.txt → verify health。适用场景：插件被 Web UI 卸载、npm link 失效、系统更新后。
- **`whistle-plugin/rules.txt` 自动加载**：插件级规则文件（`* pipe://pbmockx`），whistle 加载插件时自动注入，所有请求默认走 pipe（decode→patch→encode），无需用户在 Web UI 手写 pipe 规则。用户可在 whistle UI 里加更具体的 `pattern pipe://pbmockx` 规则做选择性 pipe。

### 变更
- **进程管理交给 w2**：`w2 start` / `w2 stop` / `w2 restart` 替代 pbmockx start/stop/restart
- **PC 证书**：`w2 ca` 替代手动安装
- **CLI 从 Python 重写为 Node.js**：通过 `w2 exec pbmockx` 或 npm link 调用，通过插件 CGI API 通信
- **PB 不转 JSON**：直接操作 message 对象，int64 是数字、enum 是数字，不做 proto3 JSON 序列化
- **JSON 展示交给 whistle**：whistle 自带 pretty-JSON 视图，插件不做
- **map_local(data) 数据存外部文件**：rules.yaml 只存引用，大 dict 在 mock-data/\<id\>.json
- **install.sh 重写**：检查 Node.js>=18 + whistle 版本检查（未装→安装/符合→跳过/不符→中断）
- **测试全 Node.js**：test_server.ts + test_pb-engine.ts（13 个单元测试）
- **skill install 只装 .agents 和 .claude**：不再装到 .config/opencode

### 移除
- ~~breakpoint~~：Web 交互难设计，移除（用 patch 规则替代）
- ~~mock/resume/abort/replay/intercept~~：随 breakpoint 一并移除
- ~~Python CLI（`bin/pbmockx`）~~：改为 Node.js CLI
- ~~Python 测试~~：改为 Node.js 测试
- ~~`scripts/start.sh`~~：旧 mitmweb 启动脚本
- ~~`addon/pbmockx_addon.py` + `scripts/start-mitmproxy.sh`~~：mitmproxy fallback 已移除
- ~~networkColumn（PB Type 列）~~：不再需要

## [0.3.0] - 2026-07-17

### 新增
- `pbmockx connect-android [-s <serial>]` 命令——独立配置 Android 设备代理（adb reverse + http_proxy），支持多设备
- `pbmockx web` 命令——打开 mitmweb Web UI 页面
- `PBJsonView` 改用 `InteractiveContentview`（mitmproxy 12 API）——支持 `reencode` 方法，待 mitmweb 新版支持后可在 Web UI 直接编辑 PB
- `render_priority` 提高到 2.0——pbmockx 成为 PB/JSON 的默认 view（优先于内置 protobuf）
- `syntax_highlight` 改为 `json`——JSON 语法高亮

### 变更
- `start.sh` 统一用 mitmweb（不再混用 mitmdump/mitmweb），`--no-web-open-browser` 不自动打开浏览器
- mitmweb 固定密码 `pbmockx`（避免随机 token）
- `start.sh` 去掉 adb 代理设置——Android 代理解耦到 `connect-android` 命令，不再绑定平台
- `rules.yaml` 从 git 移除，改为 `rules.yaml.example`（模板）+ `rules.yaml`（运行时生成，.gitignore 排除，git pull 不覆盖用户规则）

## [0.2.0] - 2026-07-16

### 变更
- 项目重命名：flowmock → pbmockx（体现 PB + JSON mock）
- 文件夹结构：文件从平铺改为 `bin/` `addon/` `scripts/` `docs/` `tests/` 分层管理
- `docs/SKILL.md` 翻译为中文
- `CHANGELOG.md` 翻译为中文
- GitHub 仓库 rename: `zztmercury/flowmock` → `zztmercury/pbmockx`
- 安装 URL: `main/install.sh` → `main/scripts/install.sh`

### 修复
- CLI `_project_dir()` 改为返回项目根目录（bin/ 上一级）
- addon rules.yaml 查找路径改为项目根目录
- start.sh `DIR` 改为项目根目录（scripts/ 上一级）
- install.sh 本地模式检测路径改为子目录结构
- E2E 测试用 `__file__` 计算项目根目录，不依赖 cwd

## [0.1.0] - 2026-07-16

### 新增
- Charles 式 mock 规则：map local / map remote / breakpoint / patch
- PB（protobuf）自动识别（Charles 自描述 Content-Type 规则）
- PB + JSON 统一 dict 解码——AI agent 按 path 改字段，不碰 wire format
- dict→PB 自动编码（map-local 提供 JSON dict，自动编码为 PB）
- 一行安装：`curl | sh`（跨平台 Python 3.10+ 检测，PATH 自动配置）
- CLI 工具维护：`skill install`、`update`、`version`、`doctor`、`start/stop/restart`
- 持久化 `rules.yaml`，运行时实时写回（重启不丢）
- LRU flow_store（500 条上限）+ path 校验（无效 path 返回 400 + hint）
- `patch_error` 暴露到 `decode` 输出——Agent 能看到 encode 失败原因
- `decode --original` 对比 patch 前后数据
- `flows --filter <regex>` / `--paused` / `clear`
- `breakpoint` per-URL 暂停（端到端验证：pause → mock → resume → 客户端收到修改后响应）
- E2E 测试：breakpoint pause/mock/resume/abort，PB patch 规则
- 版本检测：GitHub Releases API（1h 缓存，非阻塞）
- SKILL.md：PB 类型陷阱（int64 显示为字符串、enum 显示为字符串名、Any @type 元数据）

### 修复
- `echo -e` → `printf`（sh 兼容性，curl | sh 模式）
- `find_prefix` 排除隐藏工具目录（`.bun/bin`、`.cargo/bin` 等）
- `original_data` 深拷贝（之前是浅引用——`--original` 显示的是 patch 后数据）
- Patch encode 失败不再污染 decoded 视图（在 deepcopy 上操作，encode 成功才更新）
- `start.sh`：`mitmweb` → `mitmdump`（不需要 Web UI）
- `cmd_start`：`os.execv`（阻塞）→ `subprocess.Popen`（后台 daemon，不阻塞）
- `cmd_stop`：匹配 `flowmock_addon`（macOS 上 mitmdump 进程名是 Python 路径）
- 安装 URL 分支 `master` → `main`
- `--prefix` 先 mkdir 再软链
