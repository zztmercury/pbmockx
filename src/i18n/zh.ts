/**
 * CLI message catalog (Chinese). Typed as `Record<MsgKey, string>` so that
 * adding a key to `en.ts` without translating it fails `npm run typecheck`.
 *
 * 约定：
 *   - 命令名、参数名、`Usage:` 行、表格表头、`=== Request ===` 等机器可读标记保持英文。
 *   - 正文用全角标点（。、，：），参数/路径/标识符两侧用半角；行尾不留空格。
 *   - 值里的前导空格是排版用的（块状缩进），不要删。
 */

import type { MsgKey } from './en';

export const zh: Record<MsgKey, string> = {
  // --- 版本 / 公共 ---
  'cli.version': 'pbmockx {version}',

  // --- help（每条命令一个 key；Usage 行与参数名保持英文） ---
  'help.main': `Usage: pbmockx <command> [args] [options]

抓包与查看：
  flows [--filter <regex>] [--json]        列出已抓到的 flow
  decode <id> [options] [--json]           查看请求头/响应头和已解码的 body

Mock 规则：
  rules add <url> <path> <value>           添加 patch 规则
  rules add <url> <path> --append <value>  向重复字段追加值
  rules add <url> <path> --insert <idx> <value>
  rules add <url> <path> --remove <idx>
  rules add <url> <path> --unset           删除 <path> 上的键
  rules list [--type patch|map_local|map_remote] [--json]
  rules del <id> | save | reload
  map-local add <url> --data <json>|--file <path>
  map-local list | del <id>
  map-remote add <url> <replacement> [--regex]
  map-remote list | del <id>

守护进程：
  start [--port <n>] [--host <h>] [--lan] [--foreground]
  stop | restart | status [--json]
  logs [-f] [-n <lines>]
  web                                      打开 Web UI
  ca [--out <file>] [--info] [--regen --yes]

设备：
  connect-android [-s <serial>] [--wifi [host]]  配置 Android 代理并检查证书状态

维护：
  doctor [--json]                          健康检查（守护进程、CA、规则）
  fix                                      重新构建并重启守护进程
  agent-doc                                打印 SKILL.md
  skill install|list|uninstall             安装 agent 文档
  version [--check]                        显示版本 / 检查新版本
  lang [zh|en|auto]                        查看或切换 CLI 与 Web UI 的语言

选项：
  -h, --help                               显示帮助（可配合子命令使用）
  --json                                   支持的命令输出机器可读格式
  --lang <zh|en>                           输出语言（默认跟随系统 locale）

运行 'pbmockx <command> --help' 查看子命令帮助。`,

  'help.flows': `Usage: pbmockx flows [--filter <regex>] [--json]

列出已抓到的 flow（每个请求一行；请求和响应共用同一个 id）。
proto=tunnel 的行是 pbmockx 没有解密的 CONNECT 连接（bypass、端口不在
mitmPorts，或 TLS 握手失败）；'decode <id>' 会打印具体原因。

选项：
  --filter <regex>   按 URL 正则过滤
  --json             以 JSON 打印原始 API 列表
  -h, --help         显示本帮助

示例：
  pbmockx flows
  pbmockx flows --filter api/game`,

  'help.decode': `Usage: pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full] [--headers] [--json]

显示 flow 的请求头/响应头和已解码的 body（PB 字段树或 JSON）。

参数：
  id                 flow id（或 'pbmockx flows' 里的唯一前缀）

选项：
  --req              只看请求
  --res              只看响应
  --original         显示 patch 前的响应
  --path <path>      跳到指定子树（如 data.list[0].app）
  --full             展开全部字段（默认折叠）
  --headers          配合 --path/--full 时保留 method/url/headers
  --json             以 JSON 打印原始 API 详情
  -h, --help         显示本帮助

默认输出会折叠以节省 token：嵌套消息显示 (type, N fields)，重复字段显示
(repeated type, N items)。`,

  'help.rules': `Usage: pbmockx rules <subcommand> [args]

子命令：
  add <url> <path> <value> [--protocol pb|json]   替换字段值
  add <url> <path> --append <value>               向重复字段追加值
  add <url> <path> --insert <idx> <value>         在指定下标插入
  add <url> <path> --remove <idx>                 删除指定下标
  add <url> <path> --unset                        删除该键
  list [--type patch|map_local|map_remote] [--json]
  del <id>
  save
  reload

示例：
  pbmockx rules add 'api/game' game.name Mocked --protocol pb
  pbmockx rules add 'api/game' game.tags --append '{"k":"v"}'
  pbmockx rules add 'api/game' game.obsolete --unset
  pbmockx rules list --type patch`,

  'help.mapLocal': `Usage: pbmockx map-local <subcommand> [args]

子命令：
  add <url> --data '<json>' [--desc <url>] [--messageType <type>] [--delimited] [--status <code>]
  add <url> --file <path> [--status <code>]
  list
  del <id>

选项：
  --data <json>          内联 Mock 数据（保存在 mock-data/<id>.json）
  --file <path>          用本地文件作为响应 body
  --desc <url>           PB 编码用的 .desc URL
  --messageType <type>   PB 消息类型
  --delimited            PB 长度前缀分帧
  --status <code>        覆盖 HTTP 状态码
  -h, --help             显示本帮助`,

  'help.mapRemote': `Usage: pbmockx map-remote <subcommand> [args]

子命令：
  add <url> <replacement> [--regex]
  list
  del <id>

replacement 不带 scheme 时按 https:// 处理（兼容 whistle）。

选项：
  --regex        把 <replacement> 当作正则替换
  -h, --help     显示本帮助`,

  'help.start': `Usage: pbmockx start [--port <n>] [--host <h>] [--lan] [--foreground]

启动 pbmockx 守护进程（代理 + 控制 API + Web UI 共用一个端口）。

选项：
  --port <n>     监听端口（默认：配置或 8899）
  --host <h>     绑定地址（默认：127.0.0.1；局域网设备用 0.0.0.0）
  --lan          等价于 --host 0.0.0.0 且开放 UI/API 的局域网访问
  --foreground   前台运行（Ctrl+C 停止）
  -h, --help     显示本帮助

绑定 0.0.0.0 时默认开放局域网访问；在 config.json 里设置
"ui": { "lanAccess": false } 可只暴露代理。`,

  'help.restart': `Usage: pbmockx restart [--port <n>] [--host <h>] [--lan]

重启守护进程（默认沿用当前 runtime 的端口/地址）。`,

  'help.stop': `Usage: pbmockx stop

停止守护进程（先 SIGTERM，必要时 SIGKILL）。`,

  'help.status': `Usage: pbmockx status [--json]

显示守护进程状态、端口、运行时长、flow 和规则数量。`,

  'help.logs': `Usage: pbmockx logs [-f] [-n <lines>]

查看守护进程日志（默认最后 80 行）。

  -f           持续跟踪新增日志
  -n <lines>   先打印的行数`,

  'help.ca': `Usage: pbmockx ca [--out <file>] [--info] [--regen --yes]

显示 CA 信息和安装说明。

选项：
  --out <file>   把 CA 证书写入 <file>
  --info         以 JSON 打印 CA 信息
  --regen        重新生成 CA（需要 --yes；设备需重新信任）
  -h, --help     显示本帮助`,

  'help.web': `Usage: pbmockx web

在默认浏览器中打开 pbmockx Web UI。`,

  'help.connectAndroid': `Usage: pbmockx connect-android [-s <serial>] [--wifi [host]]

把 Android 设备配置为使用 pbmockx 代理（默认 adb reverse + 全局 http_proxy；
--wifi 改用局域网地址），并检测 CA 安装状态。

状态值：system | user | not_found | unknown。
用户证书目录受 SELinux 保护，非 root 设备无法自动确认 CA 状态（unknown）——
请手动到系统设置里检查。
系统证书需要 root / Magisk；本命令不会修改任何证书。

选项：
  -s <serial>   指定 adb 设备
  --wifi [host] 用局域网代理代替 adb reverse（默认取第一个局域网 IP）
  -h, --help    显示本帮助

请先用 --lan（或 --host 0.0.0.0）启动 pbmockx，局域网设备才能连上。`,

  'help.doctor': `Usage: pbmockx doctor [--json]

检查 Node 版本、数据目录、CA、守护进程健康状态、规则和 agent 文档。
守护进程不可达时执行 'pbmockx fix'。`,

  'help.fix': `Usage: pbmockx fix

重新编译 TypeScript 产物、重启守护进程并验证健康状态。
守护进程起不来或 UI/API 无法访问时使用。`,

  'help.agentDoc': `Usage: pbmockx agent-doc

打印 SKILL.md（面向 AI agent 的使用指南）。`,

  'help.skill': `Usage: pbmockx skill <install|list|uninstall>

管理 ~/.agents/skills/ 和 ~/.claude/skills/ 下的 SKILL.md。`,

  'help.version': `Usage: pbmockx version [--check]

显示版本（可选检查 GitHub releases）。`,

  // --- rules / map-* ---
  'rules.added': '规则已添加：{id} {url} {path} => {value}',
  'rules.deleted': '已删除：{ok}',
  'rules.saved': '已保存：{ok}',
  'rules.reloaded': '已重新加载：{count} 条规则',
  'mapLocal.added': 'Map local 规则已添加：{id} {url}',
  'mapRemote.added': 'Map remote 规则已添加：{id} {url} => {replacement}',

  // --- web ---
  'web.opening': '正在打开 {url}',
  'web.openManual': '请手动打开：{url}',

  // --- 错误（"Error: " 前缀本身保持英文） ---
  'error.dataInvalidJson': '--data 必须是合法的 JSON：{message}',
  'error.dataOrFile': '必须提供 --data 或 --file',
  'error.daemonDown': 'pbmockx 守护进程未运行（127.0.0.1:{port}），请执行：pbmockx start',
  'error.unknownCommand': '未知命令：{command}',
  'error.runHelp': '运行：pbmockx --help',

  // --- connect-android ---
  'connect.noLanIp': '--wifi 找不到非内部的 IPv4 地址；请显式指定 host。',
  'connect.adbMissing': 'adb 不可用。请安装 platform-tools 并确保 adb 在 PATH 中。',
  'connect.noDevice': '没有已连接的 adb 设备。请连接设备并开启 USB 调试。',
  'connect.multipleDevices': '连接了 {count} 台 adb 设备——请用 -s <serial> 指定一台。',
  'connect.availableDevices': '可用设备：',
  'connect.deviceEntry': '  {serial}（{state}）',
  'connect.deviceNotReady': '设备 {serial} 处于 {state} 状态（未就绪）。',
  'connect.authorizeRsa': '请在设备上授权 RSA 指纹，或重新连接后重试。',
  'connect.execFailed': '执行失败：{message}',
  'connect.step1': '=== 步骤 1：配置代理（已执行） ===',
  'connect.step2': '=== 步骤 2：检测状态（只读） ===',
  'connect.wifiMode': 'Wi-Fi 模式：使用 {host}:{port}（不做 adb reverse）',
  'connect.proxy': '代理：{state}{raw}{expected}',
  'connect.proxyExpected': '（期望 {expected}）',
  'connect.caHash': 'CA 哈希：{hash}',
  'connect.certStatusNoCa': '证书状态：未知（CA 尚未生成，请先运行：pbmockx start）',
  'connect.certSystem': '证书（系统）：{status}',
  'connect.certUser': '证书（用户）：{status}',
  'connect.certStatus': '证书状态：{state}',
  'connect.certReadFailed': '证书状态：未知（读取 CA 失败：{message}）',
  'connect.certFoundAt': '已找到：{dir}',
  'connect.certPermissionDenied': '无法检查（权限不足）',
  'connect.certNotFound': '未找到',
  'connect.certRequiresRoot': '需要 root（su）才能检查',
  'connect.warnUserTitle': '  警告：证书已安装为“用户”证书。',
  'connect.warnUserBody1': '  Android 7+ 应用（targetSdk>=24）默认不信任用户证书。',
  'connect.warnUserBody2': '  请安装为“系统”证书（root / Magisk / 模拟器），或在应用里配置',
  'connect.warnUserBody3': '  networkSecurityConfig。',
  'connect.manualTitle': '  手动安装步骤（本命令不会执行）：',
  'connect.manualStep1': '  1. 下载：http://{host}:{port}/__pbmockx/api/ca.pem',
  'connect.manualStep2': '  2. adb push {file} /sdcard/pbmockx-ca.crt',
  'connect.manualStep3': '  3. 设置 > 安全 > 加密与凭据 > 从存储设备安装',
  'connect.rerun': '  安装完成后重新运行：pbmockx connect-android{serial}',
  'connect.unknownTitle': '  无法自动确认证书状态：',
  'connect.unknownSystemCert': '  - 系统证书：未安装',
  'connect.unknownUserCert1': '  - 用户证书：没有 root（su）无法检查——用户证书目录',
  'connect.unknownUserCert2': '    在非 root 设备上受 SELinux 保护。',
  'connect.unknownOffline': '  （权限不足或设备离线）',
  'connect.unknownVerify1': '  请手动检查：设置 > 安全 > 加密与凭据 >',
  'connect.unknownVerify2': '    受信任的凭据 > 用户标签页（找 "pbmockx local CA"）。',
  'connect.unknownNote1': '  注意：目标 Android 7+ 的应用默认不信任用户证书，除非',
  'connect.unknownNote2': '  应用使用 networkSecurityConfig。要稳定抓 HTTPS，请安装为',
  'connect.unknownNote3': '  系统证书（root / Magisk）或使用模拟器。',
  'connect.systemOk': '  证书已安装为系统证书——应用应当信任它。',

  // --- doctor（--json 的 name/detail 保持英文，只有文本输出走翻译） ---
  'doctor.row': '{tag} {label}：{detail}',
  'doctor.version': '版本：{version}',
  'doctor.name.node': 'Node',
  'doctor.name.dataDir': '数据目录',
  'doctor.name.ca': 'CA',
  'doctor.name.daemon': '守护进程',
  'doctor.name.traffic': '流量',
  'doctor.name.fix': '修复',
  'doctor.name.legacy': '旧版 whistle',
  'doctor.name.skill': 'skill',
  'doctor.daemonDown': '未运行（127.0.0.1:{port}），请执行：pbmockx start',
  'doctor.nodeNeed': '（需要 >= 18）',
  'doctor.caPending': '尚未生成（请运行：pbmockx start）',
  'doctor.trafficWarn': '还没有抓到 flow——请配置代理并触发一次请求',
  'doctor.fixHint': '运行 pbmockx fix',
  'doctor.legacyInstalled': '{version} 已安装——pbmockx 不再使用它；如果它占用了端口 {port}，请停止它',
  'doctor.legacyAbsent': '未安装',
  'doctor.skillNotSymlink': '{path} 不是符号链接（请运行：pbmockx skill install）',
  'doctor.skillOk': '{path} -> {target}',
  'doctor.skillBroken': '{path} 已失效 -> {target}',
  'doctor.skillMissing': '{path} 未安装（请运行：pbmockx skill install）',
  'doctor.next': '下一步：pbmockx fix   （重新构建 + 重启 + 验证）',

  // --- fix ---
  'fix.step1': '[1/3] 构建中…',
  'fix.noSources': '当前安装没有 TypeScript 源码（来自 npm 安装）。',
  'fix.upgrade': '请改为升级：npm i -g pbmockx@latest && pbmockx restart',
  'fix.installingDeps': '缺少 node_modules——正在安装依赖…',
  'fix.buildOk': '构建成功',
  'fix.buildFailed': '构建失败：{message}',
  'fix.step2': '[2/3] 重启守护进程…',
  'fix.restartFailed': '重启失败：{message}',
  'fix.step3': '[3/3] 验证中…',
  'fix.notHealthy': '守护进程不健康。最后几行日志：',
  'fix.ok': 'OK——守护进程健康 | flows: {flows} | rules: {rules}',

  // --- skill ---
  'skill.dirMissing': '未找到 skill 目录：{dir}',
  'skill.installed': '已安装：{target} -> {source}',
  'skill.failed': '失败：{target} {message}',
  'skill.found': '已找到：{path} -> {target}',
  'skill.foundNotSymlink': '已找到（不是符号链接）：{path}',
  'skill.removed': '已移除：{path}',

  // --- version --check ---
  'version.updateAvailable': '最新版本：{latest}（有可用更新）',
  'version.upToDate': '已是最新版本',
  'version.checkFailed': '远程检查失败：{message}',

  // --- decode：隧道 flow ---
  'tunnel.header': '=== 隧道（未解密） ===',
  'tunnel.reason': '原因：{reason}',
  'tunnel.error': '错误：{error}',
  'tunnel.bytes': '字节：上行 {up}  下行 {down}',
  'tunnel.closed': '关闭方：{by}',
  'tunnel.client': '客户端：{ip}',
  'tunnel.flowId': 'flow id：{id}',

  // --- decode：body 渲染（=== Request/Response === 标记保持英文） ---
  'render.none': '（无）',
  'render.decodeError': '（解码错误：{message}）',
  'render.empty': '（空）',
  'render.pathNotFound': '未找到路径：{path}',
  'render.availableFields': '可用的顶层字段：{fields}',

  // --- start ---
  'start.alreadyRunning': 'pbmockx 已在运行：http://{host}:{port}（pid {pid}）',
  'start.lanLine': '  局域网：http://{ip}:{port}/',
  'start.foreground': 'pbmockx 守护进程运行中：http://{host}:{port}（Ctrl+C 停止）',
  'start.failed': 'pbmockx 启动失败。最后几行日志：',
  'start.started': 'pbmockx 已启动（pid {pid}）',
  'start.proxyLine': '  代理：{host}:{port}',
  'start.uiLine': '  UI：http://{host}:{port}/',
  'start.lanAddress': '  局域网：http://{ip}:{port}/（代理 {ip}:{port}）',
  'start.lanNote1': '局域网提示：同一网络的设备可以打开 UI 并读取抓到的流量。',
  'start.lanNote2': '          在 config.json 中设置 ui.lanAccess=false 可只暴露代理。',
  'start.noLanIp': '  局域网：未检测到非内部的 IPv4 地址',
  'start.dataLine': '  数据目录：{dir}',
  'start.caLine': '  CA：{file}',
  'start.next': '下一步：在设备上安装 CA（pbmockx ca），然后配置上面的代理。',

  // --- stop ---
  'stop.notRunning': 'pbmockx 未运行',
  'stop.failed': '停止失败：{message}',
  'stop.stopped': 'pbmockx 已停止',

  // --- status ---
  'status.daemonRunning': '守护进程：运行中（pid {pid}）http://{host}:{port}',
  'status.uptime': '运行时长：{uptime} | flows: {flows} | rules: {rules}',
  'status.ui': 'UI：http://{host}:{port}/',
  'status.lan': '局域网：http://{ip}:{port}/（代理 {ip}:{port}）',
  'status.notRunning': '守护进程：未运行',
  'status.start': '启动：pbmockx start{dataDir}',

  // --- ca ---
  'ca.regenNeedsYes': '未加 --yes，拒绝重新生成 CA（所有设备都需要重新信任）。',
  'ca.regenerated': 'CA 已重新生成：{file}',
  'ca.restarting': '正在重启守护进程以加载新 CA…',
  'ca.generated': 'CA 已生成：{file}',
  'ca.restartToLoad': '重启守护进程以加载它：pbmockx restart',
  'ca.wrote': 'CA 证书已写入：{file}',
  'ca.certificate': 'CA 证书：{file}',
  'ca.subject': '主题：{subject}',
  'ca.sha256': 'SHA-256：{fingerprint}',
  'ca.androidHash': 'Android 哈希：{hash}',
  'ca.valid': '有效期：{notBefore} -> {notAfter}',
  'ca.installTitle': '在客户端设备上安装：',
  'ca.download': '  下载：http://127.0.0.1:{port}/__pbmockx/api/ca.pem',
  'ca.copyFile': '  复制文件：pbmockx ca --out ./pbmockx-ca.crt',
  'ca.android': 'Android：pbmockx connect-android   （配置代理 + 检查证书；系统证书需要 root/Magisk）',

  // --- lang ---
  'lang.current': '当前语言：{lang}',
  'lang.source': '来源    ：{source}',
  'lang.source.env': 'PBMOCKX_LANG 环境变量',
  'lang.source.config': 'config.json',
  'lang.source.system': '系统 locale',
  'lang.source.default': '默认（英文）',
  'lang.name.en': 'English',
  'lang.name.zh': '中文',
  'lang.configLine': '配置    ：lang={value}',
  'lang.autoLine': '配置    ：未设置（跟随系统 locale）',
  'lang.envHint': '注意    ：当前 shell 设置了 PBMOCKX_LANG={env}，它的优先级高于 config.json',
  'lang.set': '语言已切换为 {lang}（config.json: lang={value}）',
  'lang.cleared': '已清除 config 中的 lang，恢复跟随系统 locale',
  'lang.invalid': '不支持的语言 "{value}"（可用：zh、en、auto）',
  'lang.restarting': '正在重启守护进程，让 Web UI 一并生效...',
  'lang.restartHint': '守护进程未运行，下次 pbmockx start 时会使用该设置。',
  'help.lang': `用法：pbmockx lang [zh|en|auto]

查看或设置 CLI 输出与 Web UI 的语言。

  lang                  查看当前语言及其来源
  lang zh | en          持久化到 config.json（运行中的守护进程会自动重启）
  lang auto             删除该设置，恢复跟随系统 locale
  lang --json           机器可读输出 {lang, source, config}`,
};
