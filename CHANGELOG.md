# Changelog

所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
