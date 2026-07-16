# AGENTS.md — pbmockx 开发指南

面向 Agent 的高信噪比上下文。用户使用指南在 `docs/SKILL.md`（`pbmockx help`/`agent-doc` 打印）——本文件只覆盖开发者关注点。

## 架构

两个 Python 运行时，通过 HTTP control API 连接：

```
bin/pbmockx (CLI)  ──HTTP :9090──►  addon/pbmockx_addon.py (mitmdump 进程内)
  纯 stdlib (urllib)                  mitmproxy addon（PB 引擎 + mock 规则 + control API）
  系统自带 python3 运行              venv 内运行（mitmproxy + protobuf + requests）
```

- `bin/pbmockx` CLI 是**纯 stdlib**——系统自带 python3 即可运行，不需要 venv。通过 `urllib` 访问 `http://127.0.0.1:9090`。
- `addon/pbmockx_addon.py` 作为 `-s` 脚本运行在 **mitmdump 进程内**。有 `request()` hook（map_remote）和 `response()` hook（detect → decode → map_local → patch → breakpoint）。
- `scripts/start.sh` 启动 `mitmdump -s addon/pbmockx_addon.py --mode regular@127.0.0.1:8080 --set pbmockx_control_port=9090`。
- `scripts/install.sh` 创建 `.venv/` + 软链 CLI 到 PATH。**不负责安装 SKILL.md**（由 `pbmockx skill install` 完成）。

## 命令

```bash
# 安装
./scripts/install.sh    # 本地：venv + CLI 软链 + PATH
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"  # 远程一行

# 运行
pbmockx start          # 后台 daemon（不阻塞，等待 control API ≤15s）
pbmockx stop           # pkill -f pbmockx_addon
pbmockx doctor         # 全链路检查（python/venv/cli/skill/addon/version）
pbmockx connect-android [-s <serial>]  # Android 设备代理（adb reverse + http_proxy）

# 测试（无 pytest——直接跑脚本）
.venv/bin/python tests/test_engine.py          # 离线：PBEngine + MockRule/MockEngine 单元测试
.venv/bin/python tests/test_breakpoint_e2e.py  # E2E：breakpoint pause/mock/resume/abort（自启进程）
.venv/bin/python tests/test_patch_e2e.py       # E2E：PB patch 规则（验证交付字节 + --original）

# Lint / typecheck
# 无——仓库未配置 linter/formatter/typechecker。
```

E2E 测试自启 `tests/test_server.py`(:8889) + `mitmdump`+addon(:8080/:9090) 子进程，轮询 `/health`，打印 `[PASS]/[FAIL]`，exit 0/1。无测试框架——纯 assert。

## 规则引擎（4 种类型）

`MockRule`（`addon/pbmockx_addon.py`）——统一类，`type` 字段选择属性：

| type | hook | 关键字段 | 作用 |
|---|---|---|---|
| `patch` | response | `path`, `value`, `protocol` | `set_by_path` 改 decoded dict 字段，再 re-encode |
| `map_local` | response | `source`(file\|data), `file_path`\|`data`, `desc`, `messageType` | 整 body 替换 |
| `map_remote` | request | `replacement`, `is_regex` | 重写 `flow.request.url` + Host header |
| `breakpoint` | response | `phase` | `flow.intercept()` 暂停 flow |

执行顺序：`map_remote(request) → map_local(response) → breakpoint(response) → patch(response)`。

`rules.yaml` 启动时自动加载（`MockEngine.reload`），add/del 时自动保存（`MockEngine.save`）。保存时保留头部注释（`#` 开头或空行）。规则 ID 为 `uuid4()[:8]`。`rules.yaml` 被 `.gitignore` 排除（运行时生成），仓库里有 `rules.yaml.example` 作为模板。

## 关键陷阱

### PB 类型不匹配（最常见 encode 失败原因）
decoded JSON **不保留** PB 类型信息：
- **int64/uint64** → 显示为**字符串**（`"123"` 非 `123`）。patch 时传 `123`(int) 或 `"123"`(数字字符串)。`"sku1"` → encode 失败。
- **enum** → 显示为**字符串名**（`"STATUS_ACTIVE"`）。patch 时传名字或数字。
- **bytes** → 显示为 **base64 字符串**。
- **google.protobuf.Any** → 有 `@type` 元数据。**不要修改 `@type`**。
- **加 patch 规则后务必检查 `patch_error`**（`decode` 输出里能看到 encode 失败原因）。

### Patch encode 失败处理（0.1.0 修复）
Patch 在 `copy.deepcopy(data)` 上操作。`flow.response.content` + 视图 `data` **仅在 encode 成功时更新**。失败时：记录 `patch_error`，response.content 保持原始值。`original_data` 也是 deepcopy（之前是浅引用 bug）。

### Breakpoint 导致客户端超时
Breakpoint **暂停 flow——客户端等待**。Agent 异步处理（find → decode → mock → resume，每步 ~2s LLM 推理）可能超过客户端超时。**优先用 patch 规则。** Breakpoint 规则是持久的——用完务必 `pbmockx breakpoint off`。

### 单次 mock 不会送达客户端
`mock <id>` 在已完成的 flow 上只改存储数据。用 patch 规则（首选），或 `intercept on`→`mock`→`resume`，或 `mock`+`replay`。

## 约定

- **`docs/SKILL.md` 是唯一真理来源**——`pbmockx help`/`agent-doc` 打印它。改动会传播给所有 agent。保持 frontmatter（`name`、`description` 及触发词）完整。
- CLI 用手写 argv 分发（`main()` 里 if/elif 链，无 argparse）。`cmd_<verb>` 函数。部分用 `type("A", (), {...})()` mock-namespace 传参。
- `addon/pbmockx_addon.py` 的类名仍是 `TapPbMock`（历史遗留）。对外全部用 `pbmockx`。
- `ruamel.yaml` 在 `MockEngine.save()`/`reload()` 内**惰性导入**——不在 pip install 行里，随 mitmproxy 传递安装。
- Python 3.10+（install.sh 强制）。用了 walrus operator `:=`（3.8+）。无 match-case。
- `pbmockx.log` 是运行时日志（后台 daemon 的 stdout/stderr）。`.gitignore` 排除 `*.log`。
- Git：main 分支。发版 = `git tag vX.Y.Z` + `gh release create`。VERSION 文件是权威版本来源。

## 版本 + 发版流程

```bash
echo "0.2.0" > VERSION
# 更新 CHANGELOG.md
git add VERSION CHANGELOG.md && git commit -m "release: v0.2.0"
git tag v0.2.0 && git push && git push --tags
gh release create v0.2.0 --notes-file CHANGELOG.md --title "v0.2.0"
```

`_check_remote_version()` 请求 `releases/latest` API，缓存 1h（`~/.pbmockx/.version_cache`）。`pbmockx start` 和 `doctor` 非阻塞检测。
