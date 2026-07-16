# pbmockx

mitmproxy 替代 Charles 抓包查看/修改 **protobuf + JSON** 数据，专为 AI agent 工作流设计。

addon 自动识别协议（按 Charles Protocol Buffers 自描述规则：Content-Type 携带 `desc`/`messageType`/`delimited`），把 PB 和 JSON 统一解码成 dict，AI agent 通过 CLI 按 path 改字段，不碰 protobuf wire format。

## 能力
- **协议自动识别**：`application/x-protobuf`(带 desc) / `application/json` 自动判别
- **PB 解码**：复刻 Charles 规则——解析 Content-Type 的 desc URL → 下载 `.desc`(FileDescriptorSet，带 HTTP 缓存) → `descriptor_pool` 动态建类 → `ParseFromString` → `json_format.MessageToDict`(保留 proto 字段名)
- **JSON 解码**：原生 `json.loads`
- **统一 dict 化**：PB 和 JSON 都成 dict，操作方式一致
- **双向编码**：dict → PB(`ParseDict`+`SerializeToString`) / dict → JSON，支持 delimited 列表
- **Charles 式 mock**：
  - `map-local`：整 body 替换（支持 raw 文件 或 dict→PB 自动 encode）
  - `map-remote`：请求重定向（完整 URL 替换 / regex 部分替换）
  - `breakpoint`：per-URL 暂停（规则式，不再全局阻塞）
  - `patch`：按 path 改字段（原有能力）
- **持久化规则**：rules add/del 实时写回 rules.yaml，重启不丢
- **control API**（:9090）+ **CLI** + **SKILL.md**，多 agent 通用

## 安装

### 一行安装
```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
```

### 本地安装（调试用）
```bash
git clone https://github.com/zztmercury/pbmockx.git
cd pbmockx
./scripts/install.sh
```

install.sh 只负责部署 CLI（venv + 软链 + PATH）。
安装 skill、检测更新等通过 CLI 子命令：
```bash
pbmockx skill install     # 安装 SKILL.md 到 agent skill 目录
pbmockx doctor            # 环境健康检查
pbmockx update            # 自更新
```

## 启动
```bash
pbmockx start             # 起 mitmdump + addon（不绑定平台）
pbmockx connect-android  # 配置 Android 设备代理（adb reverse + http_proxy，可选 -s <serial>）
```
首次按提示装 CA 证书（用户证书：设备访问 [http://mitm.it](http://mitm.it)；系统证书见 [mitmproxy 官方文档](https://docs.mitmproxy.org/stable/howto/install-system-trusted-ca-android/)）。

## CLI（AI agent 用）
```bash
# 查看
pbmockx flows [--filter <regex>] [--paused]  # 列 flow + 协议标签 + 暂停标记
pbmockx decode <id> [--original]              # 解码 dict（--original 看原始响应）
pbmockx flows clear                          # 清空 flow_store

# Mock — patch（按 path 改字段）
pbmockx mock <id> game.name 测试              # 单条改
pbmockx rules add 'api/game' game.name 测试   # 持续规则

# Mock — map-local（整 body 替换，Charles 式）
pbmockx map-local add 'api/game' ./mock.json  # raw 文件替换
pbmockx map-local add 'api/game' --data '{"game":{"name":"test"}}'  # dict→PB encode
pbmockx map-local list / del <id>

# Mock — map-remote（请求重定向）
pbmockx map-remote add 'api.test.com' 'http://mock-server.com'  # 完整 URL 替换
pbmockx map-remote add 'api/test' 'api/mock' --regex            # regex 部分替换
pbmockx map-remote list / del <id>

# Mock — breakpoint（per-URL 暂停）
pbmockx breakpoint add 'api/game'             # 加断点规则
pbmockx breakpoint list / del <id> / off

# 暂停后操作
pbmockx mock <id> game.name 测试              # 改字段
pbmockx resume <id>                           # 放行
pbmockx abort <id>                            # 取消（给客户端发错误）

# 规则管理
pbmockx rules list [--type <type>]            # 列规则（按类型过滤）
pbmockx rules del <id>                        # 按 id 删
pbmockx rules save / reload                   # 手动持久化/重载

# 工具维护
pbmockx skill install / list / uninstall      # 安装/列出/卸载 SKILL.md
pbmockx update [--check]                      # 检测/执行自更新
pbmockx version                               # 版本号
pbmockx doctor                                # 全链路健康检查
pbmockx start / stop / restart                # 启动/停止/重启
pbmockx connect-android [-s <serial>]        # 配置 Android 设备代理
```

## 接入 agent
- **opencode**：`pbmockx skill install` 自动装到 `~/.agents/skills/pbmockx/`
- **Claude Code**：同上，自动检测 `~/.claude/skills/`
- **其他 agent**：跑 `pbmockx agent-doc` 取使用说明注入 system prompt，或 `pbmockx skill install --dir <path>`

## 文件
- `addon/pbmockx_addon.py` — mitmproxy addon（协议识别/PB/JSON/dict/双向/mock/control API/InteractiveContentview）
- `bin/pbmockx` — CLI（纯 stdlib，调 control API + 工具维护）
- `scripts/install.sh` — 一键安装（curl | sh）
- `scripts/start.sh` — 启动脚本（mitmdump，不绑定平台）
- `scripts/connect-android.sh` — Android 设备代理配置（adb reverse）
- `docs/SKILL.md` — agent 文档（与 CLI `agent-doc` 同源）
- `rules.yaml.example` — 规则模板（git tracked）；运行时生成 `rules.yaml`（.gitignore 排除，不受 git pull 影响）
- `tests/test_engine.py` / `tests/test_server.py` — 测试

## 与 Charles 对比
| | Charles | pbmockx |
|---|---|---|
| PB schema | `.desc`/`.proto` | `.desc`（同 Charles 规则） |
| PB 查看 | Text/Structured Viewer | Web UI 默认 pbmockx view（格式化 JSON）|
| PB 修改 | Structured 双击改 | CLI path+value（AI 可操作）；Web UI 编辑待 mitmweb 支持 |
| JSON | 原生 | 原生 |
| Map Local | 整文件替换 | 整文件 + dict→PB encode |
| Map Remote | URL 映射 | 完整 URL + regex 替换 |
| Breakpoint | per-URL 暂停 | per-URL 规则式暂停 |
| 持久化规则 | 启动时配置 | rules.yaml 实时写回 |
| AI 接入 | 无 | CLI + agent-doc，多框架通用 |
