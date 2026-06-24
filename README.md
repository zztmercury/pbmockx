# mitmproxy-mock

mitmproxy 替代 Charles 抓包查看/修改 **protobuf + JSON** 数据，专为 AI agent 工作流设计。

addon 自动识别协议（按 Charles Protocol Buffers 自描述规则：Content-Type 携带 `desc`/`messageType`/`delimited`），把 PB 和 JSON 统一解码成 dict，AI agent 通过 CLI 按 path 改字段，不碰 protobuf wire format。

## 能力
- **协议自动识别**：`application/x-protobuf`(带 desc) / `application/json` 自动判别
- **PB 解码**：复刻 Charles 规则——解析 Content-Type 的 desc URL → 下载 `.desc`(FileDescriptorSet，带 HTTP 缓存) → `descriptor_pool` 动态建类 → `ParseFromString` → `json_format.MessageToDict`(保留 proto 字段名)
- **JSON 解码**：原生 `json.loads`
- **统一 dict 化**：PB 和 JSON 都成 dict，操作方式一致
- **双向编码**：dict → PB(`ParseDict`+`SerializeToString`) / dict → JSON，支持 delimited 列表
- **两种 mock**：规则持续（response hook 实时改）+ 单条实时（mock + intercept/resume/replay）
- **control API**（:9090）+ **CLI** + **SKILL.md**，多 agent 通用

## 一次性安装
```bash
brew install python@3.13
cd ~/Projects/mitmproxy-mock
/opt/homebrew/bin/python3.13 -m venv .venv
.venv/bin/pip install mitmproxy protobuf requests
```

## 启动
```bash
./start.sh                      # 起 mitmweb + addon + adb reverse + 设备代理
```
首次按提示装 CA 证书（用户证书：设备访问 http://mitm.it；系统证书见 mitmproxy 官方文档）。

## CLI（AI agent 用）
```bash
mitmproxy-mock flows                       # 列 flow + 协议标签
mitmproxy-mock decode <id>                 # 解码 dict
mitmproxy-mock mock <id> game.name 测试     # 单条改
mitmproxy-mock rules add 'api/game' game.name 测试   # 持续规则
mitmproxy-mock agent-doc                   # 输出 agent 使用说明
```

## 接入 agent
- **opencode**：SKILL.md 软链到 `~/.agents/skills/mitmproxy-mock/SKILL.md` 自动加载
- **其他 agent**：跑 `mitmproxy-mock agent-doc` 取使用说明注入 system prompt

## 文件
- `tap_pb_mock.py` — mitmproxy addon（协议识别/PB/JSON/dict/双向/mock/control API/contentview）
- `mitmproxy-mock` — CLI（纯 stdlib，调 control API）
- `start.sh` — 一键启动
- `SKILL.md` — agent 文档（与 CLI `agent-doc` 同源）
- `rules.yaml` — 持久化 mock 规则（启动时自动加载）
- `test_pb_engine.py` / `test_server.py` — 测试

## 与 Charles 对比
| | Charles | mitmproxy-mock |
|---|---|---|
| PB schema | `.desc`/`.proto` | `.desc`（同 Charles 规则） |
| PB 查看 | Text/Structured Viewer | contentview + control API |
| PB 修改 | Structured 双击改 | CLI path+value（AI 可操作） |
| JSON | 原生 | 原生 |
| AI 接入 | 无 | CLI + agent-doc，多框架通用 |
