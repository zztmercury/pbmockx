/**
 * Web UI i18n — zero build, CSP-safe (static module, no inline script).
 *
 * Precedence for the initial language:
 *   ?lang=zh                 (shareable link, wins over everything)
 *   localStorage 'pbmockx-lang'  (explicit user choice via the UI toggle)
 *   server default           (daemon resolved --lang / config.json / system locale)
 *   navigator.language       (zh* -> zh)
 *   en
 *
 * Static markup is translated through data attributes:
 *   data-i18n="key"              -> textContent
 *   data-i18n-title="key"        -> title
 *   data-i18n-aria="key"         -> aria-label
 *   data-i18n-placeholder="key"  -> placeholder
 *
 * Dynamic markup calls t('key', { var }) at render time.
 *
 * Keys are `area.thing`: topbar/list/tree/detail/kv/body/rules/setup/...
 * Machine data stays untranslated on purpose: HTTP methods and status lines,
 * header names, `object_type`, protobuf field names, rule types
 * (`patch`/`map_local`/`map_remote`), file names (`rules.yaml`, `mock-data`),
 * IDs, byte counts, URLs and JSON keys.
 */

const STORAGE_KEY = 'pbmockx-lang';

let lang = 'en';
const missing = new Set();

/** Message catalogs. `scripts/check-i18n.js` verifies key parity across en/zh. */
export const dict = {
  en: {
    // --- shell / topbar ---
    'app.title': 'pbmockx',
    'lang.switch': '中文',
    'lang.title': 'Switch language (currently English)',
    'topbar.daemonStatus': 'daemon status',
    'conn.connecting': 'connecting',
    'conn.live': 'live',
    'conn.offline': 'offline',
    'conn.reconnecting': 'reconnecting…',
    'nav.pause': 'Pause',
    'nav.paused': 'Paused',
    'nav.pauseTitle': 'Pause live updates',
    'nav.clear': 'Clear',
    'nav.clearTitle': 'Clear captured flows',
    'nav.rules': 'Rules',
    'nav.rulesTitle': 'Mock rules',
    'nav.setup': 'Setup',
    'nav.setupTitle': 'Certificate and proxy setup',
    'nav.themeTitle': 'Toggle theme',

    // --- flow list (sidebar) ---
    'list.filterPlaceholder': 'Filter flows (regex or text)   /',
    'list.layoutAria': 'List layout',
    'list.flat': 'Flat',
    'list.tree': 'Tree',
    'list.expandAll': 'Expand all groups',
    'list.collapseAll': 'Collapse all groups',
    'list.capturedAria': 'Captured flows',
    'list.count': '{shown} / {total} flows',
    'list.empty.title': 'Waiting for traffic',
    'list.empty.hint': 'Configure your device or app to use this proxy:',
    'list.empty.copy': 'Copy proxy address',
    'list.splitterAria': 'Resize flow list',
    'list.splitterTitle': 'Drag to resize the flow list',
    'list.treeHint': 'Groups are collapsed — click a host to expand. Use ⊞ / ⊟ for everything.',
    'list.tagMock': 'mock',
    'list.tagTunnel': 'tunnel',
    'list.tagErr': 'err',

    // --- flow list tree ---
    'tree.hostTitle': '{host} — {n} request(s)',
    'tree.pathTitle': '{host}{path} — {n} request(s)',
    'tree.unknownHost': '(unknown host)',
    'tree.unset': '(unset)',
    'tree.items': '{n} items',
    'tree.entries': '{n} entries',
    'tree.emptyMessage': 'empty message',
    'tree.empty': '(empty)',

    // --- detail: empty state, tabs, header ---
    'detail.empty.title': 'Select a flow',
    'detail.empty.hint': 'Pick a request on the left to inspect its headers and decoded body.',
    'detail.empty.pbHint': 'Protobuf responses are shown as a typed field tree — no JSON conversion.',
    'detail.tab.summary': 'Summary',
    'detail.tab.request': 'Request',
    'detail.tab.response': 'Response',
    'detail.copyUrl': 'Copy URL',
    'detail.reqSize': 'req {size}',
    'detail.respSize': 'resp {size}',
    'detail.mocked': 'mocked',
    'detail.patched': 'patched',
    'detail.notDecrypted': 'not decrypted',
    'detail.reqHeaders': 'Request headers',
    'detail.resHeaders': 'Response headers',
    'detail.reqBody': 'Request body',
    'detail.resBody': 'Response body',
    'detail.matchedRules': 'Matched rules',
    'detail.queryCount': 'Query ({n})',
    'detail.noReqHeaders': '(no headers)',
    'detail.noResHeaders': '(no headers)',
    'detail.truncated': '(truncated)',
    'detail.mode.decoded': 'Decoded',
    'detail.mode.raw': 'Raw',
    'detail.mode.hex': 'Hex',
    'detail.mode.patched': 'Patched',
    'detail.mode.original': 'Original',
    'detail.card.overview': 'Overview',
    'detail.card.timing': 'Timing',
    'detail.card.notDecrypted': 'Not decrypted',
    'card.expand': 'Expand {title}',
    'card.collapse': 'Collapse {title}',

    // --- key/value labels (overview, tunnel metadata, timing) ---
    'kv.method': 'method',
    'kv.status': 'status',
    'kv.url': 'url',
    'kv.originalUrl': 'original URL',
    'kv.request': 'request',
    'kv.response': 'response',
    'kv.duration': 'duration',
    'kv.reqBytes': 'request bytes',
    'kv.resBytes': 'response bytes',
    'kv.contentEncoding': 'content-encoding',
    'kv.started': 'started',
    'kv.flowId': 'flow id',
    'kv.reason': 'reason',
    'kv.connect': 'connect',
    'kv.error': 'error',
    'kv.bytesUp': 'bytes up',
    'kv.bytesDown': 'bytes down',
    'kv.closed': 'closed',
    'kv.client': 'client',
    'kv.start': 'start',
    'kv.upstreamConnected': 'upstream connected',
    'kv.firstByte': 'first byte',
    'kv.complete': 'complete',

    // --- diagnostic banners (patch_error/decode_error stay verbatim: they are
    // record field names the CLI and API also print) ---
    'problem.error': 'error',
    'problem.patchError': 'patch_error',
    'problem.decodeError': 'decode_error',
    'problem.reqDecode': 'request decode',
    'problem.resDecode': 'response decode',
    'problem.note': 'note',
    'problem.truncatedNote': 'Response body was truncated at the recording cap; decoding may be incomplete.',

    // --- why a CONNECT was not decrypted ---
    'tunnel.bypass': 'This host matches proxy.bypass, so pbmockx opened a raw TCP tunnel and never saw plaintext. Remove the bypass entry (or narrow it) to capture and mock it.',
    'tunnel.mitmDisabled': 'proxy.mitm is false globally, so every HTTPS connection is tunnelled without decryption. Set "mitm": true in config.json.',
    'tunnel.port': 'This CONNECT port is not in proxy.mitmPorts (default 443, 8443), so the tunnel was not intercepted. Add the port to capture it.',
    'tunnel.tlsHandshake': 'The CONNECT was intercepted but the TLS handshake failed. Usual causes: the CA is not installed/trusted on the client, the app pins its certificate, it requires mTLS, or it does not speak TLS/HTTP at all.',
    'tunnel.caError': 'pbmockx could not issue a leaf certificate for this host — check the data directory permissions and the CA files.',

    // --- bodies ---
    'body.notAvailable': 'Body not available (HTTP {status})',
    'body.moreBytes': '… {n} more bytes',
    'body.truncatedForDisplay': '… (truncated for display)',
    'body.noData': 'No data yet',
    'body.notDecodable': 'Body is not decodable (use Raw/Hex)',
    'body.empty': '(empty body)',

    // --- shared buttons / states ---
    'common.copy': 'Copy',
    'common.download': 'Download',
    'common.copied': 'Copied',
    'common.copyFailed': 'Copy failed',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.reload': 'Reload',
    'common.closeEsc': 'Close (Esc)',
    'common.loading': 'Loading…',
    'common.emptyParen': '(empty)',

    // --- drawer ---
    'drawer.tabRules': 'Mock rules',
    'drawer.tabSetup': 'Setup & CA',

    // --- confirmations / toasts ---
    'confirm.clearFlows': 'Clear all captured flows?',
    'toast.flowsCleared': 'Flows cleared',

    // --- rules panel ---
    'rules.add': '+ Add rule',
    'rules.addTitle': 'Add mock rule',
    'rules.addSubmit': 'Add rule',
    'rules.added': 'Rule added',
    'rules.saved': 'rules.yaml saved',
    'rules.reloaded': 'Reloaded {n} rules',
    'rules.empty': 'No rules yet. Add a patch rule to modify a response field.',
    'rules.typePatch': 'Patch',
    'rules.typeMapLocal': 'Map local',
    'rules.typeMapRemote': 'Map remote',
    'rules.enable': 'Enable rule',
    'rules.disable': 'Disable rule',
    'rules.editMock': 'Edit mock data',
    'rules.delete': 'Delete rule',
    'rules.deleteConfirm': 'Delete rule {id}?',
    'rules.deleted': 'Rule deleted',
    'rules.fieldType': 'Rule type',
    'rules.fieldUrlPattern': 'URL pattern (regex)',
    'rules.phUrlPattern': 'URL regex, e.g. api/game',
    'rules.typeOption.patch': 'Patch — modify a response field',
    'rules.typeOption.mapLocal': 'Map local — replace the whole response',
    'rules.typeOption.mapRemote': 'Map remote — rewrite the request URL',
    'rules.fieldPath': 'Path',
    'rules.phPath': 'field path, e.g. game.name',
    'rules.fieldAction': 'Action',
    'rules.action.set': 'set (replace)',
    'rules.action.append': 'append',
    'rules.action.insert': 'insert',
    'rules.action.remove': 'remove',
    'rules.action.unset': 'unset (delete key)',
    'rules.fieldIndex': 'Index (optional)',
    'rules.phIndex': 'index (insert/remove)',
    'rules.fieldProtocol': 'Protocol (optional)',
    'rules.protocol.both': 'both',
    'rules.fieldValue': 'Value',
    'rules.phValue': 'Value as JSON, e.g. "Mocked" / 999 / {"k":"v"} / false',
    'rules.fieldSource': 'Source',
    'rules.source.data': 'data — JSON encoded to protobuf',
    'rules.source.file': 'file — serve local bytes',
    'rules.fieldStatus': 'Status (optional)',
    'rules.phStatus': 'status code override, e.g. 200',
    'rules.fieldDesc': 'desc (optional)',
    'rules.phDesc': 'desc URL (optional for PB)',
    'rules.fieldMessageType': 'messageType (optional)',
    'rules.phMessageType': 'messageType (optional for PB)',
    'rules.fieldMockData': 'Mock data (JSON)',
    'rules.phMockData': 'JSON body, e.g. {"game":{"name":"Mocked"}}',
    'rules.fieldFilePath': 'Local file path',
    'rules.phFilePath': '/absolute/path/to/mock.bin',
    'rules.fieldReplacement': 'Replacement',
    'rules.phReplacement': 'https://new.example.com/path or 127.0.0.1:9101/path',
    'rules.regexLabel': 'Treat replacement as a regex',
    'rules.editTitle': 'Edit {file}',
    'rules.mockSaved': 'Mock data saved',
    'rules.invalidJson': 'Invalid JSON: {msg}',
    'rules.metaUnset': 'value: (unset)',
    'rules.errUrlPattern': 'URL pattern is required',
    'rules.errPath': 'Path is required',
    'rules.errValue': 'Value is required for set',
    'rules.errMockJson': 'Mock data must be valid JSON: {msg}',
    'rules.errFile': 'File path is required',
    'rules.errUrlReplacement': 'URL and replacement are required',

    // --- setup / CA panel ---
    'setup.proxy': 'Proxy',
    'setup.proxyNote': 'Point your device/browser HTTP proxy at this address. HTTPS is captured via a local CA.',
    'setup.thisMachineIp': '<this-machine-ip>',
    'setup.lanNote': 'Bound to 0.0.0.0 — devices on the same LAN can use this proxy and open the UI. Only do this on trusted networks.',
    'setup.otherAddresses': 'Other addresses: {list}',
    'setup.lanUiDisabled': 'LAN UI access is disabled (ui.lanAccess=false); the proxy is reachable but the UI/API are loopback-only.',
    'setup.notDecrypted': 'Not decrypted',
    'setup.notDecryptedNote': 'HTTPS is only decrypted when CONNECT passes the rules below. Everything else is tunnelled as raw TCP and appears in the flow list as a metadata-only "tunnel" record.',
    'setup.mitm': 'MITM',
    'setup.mitmOff': 'disabled (proxy.mitm=false)',
    'setup.enabled': 'enabled',
    'setup.ports': 'ports',
    'setup.allPorts': 'all ports',
    'setup.bypass': 'bypass',
    'setup.none': '(none)',
    'setup.tunnelRecords': 'tunnel records',
    'setup.tunnelRecordsOff': 'off (proxy.recordTunnels=false)',
    'setup.on': 'on',
    'setup.ca': 'Certificate authority',
    'setup.file': 'File',
    'setup.subject': 'Subject',
    'setup.sha256': 'SHA-256',
    'setup.androidHash': 'Android hash',
    'setup.valid': 'Valid',
    'setup.downloadCa': 'Download CA (.crt)',
    'setup.copyPath': 'Copy path',
    'setup.caTrustNote': 'Trust this CA on any device whose HTTPS traffic you want to inspect. Remove it when you are done.',
    'setup.caMissing': 'CA not available yet. Start the daemon first: pbmockx start',
    'setup.installCa': 'Install the CA',
    'setup.stepMac1': 'Download the CA (.crt) above.',
    'setup.stepMac2': 'Open <code>pbmockx-ca.crt</code> in Keychain Access → System → <b>Always Trust</b>.',
    'setup.stepMac3': 'Or: <code>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain pbmockx-ca.crt</code>',
    'setup.stepWin1': 'Download the CA, then run <code>certutil -addstore -f "ROOT" pbmockx-ca.crt</code> as Administrator.',
    'setup.stepLinux1': '<code>sudo cp pbmockx-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</code>',
    'setup.stepLinux2': 'For Chrome/Electron apps, also import it under Settings → Privacy → Manage certificates → Authorities.',
    'setup.stepAndroid1': 'Enable USB debugging, then run <code>pbmockx connect-android</code> to set <code>adb reverse</code> + <code>http_proxy</code>.',
    'setup.stepAndroid2': 'User certificates are not trusted by apps targeting Android 7+ — install as a system cert (root / Magisk) or use an emulator.',
    'setup.stepAndroid3': 'Download URL: <code>/__pbmockx/api/ca.pem</code>',
    'setup.dataLimits': 'Data & limits',
    'setup.dataDir': 'Data directory',
    'setup.rulesFile': 'rules.yaml',
    'setup.mockData': 'mock-data',
    'setup.maxFlows': 'max flows',
    'setup.recordBodyCap': 'record body cap',
    'setup.totalRecordCap': 'total record cap',
    'setup.rewriteBodyCap': 'rewrite body cap',
  },
  zh: {
    // --- shell / topbar ---
    'app.title': 'pbmockx',
    'lang.switch': 'EN',
    'lang.title': '切换语言（当前：中文）',
    'topbar.daemonStatus': '守护进程状态',
    'conn.connecting': '连接中',
    'conn.live': '在线',
    'conn.offline': '离线',
    'conn.reconnecting': '重新连接中…',
    'nav.pause': '暂停',
    'nav.paused': '已暂停',
    'nav.pauseTitle': '暂停实时更新',
    'nav.clear': '清空',
    'nav.clearTitle': '清空已抓取的 flow',
    'nav.rules': '规则',
    'nav.rulesTitle': 'Mock 规则',
    'nav.setup': '设置',
    'nav.setupTitle': '证书与代理设置',
    'nav.themeTitle': '切换主题',

    // --- flow list (sidebar) ---
    'list.filterPlaceholder': '过滤 flow（正则或文本）   /',
    'list.layoutAria': '列表布局',
    'list.flat': '平铺',
    'list.tree': '树形',
    'list.expandAll': '展开所有分组',
    'list.collapseAll': '折叠所有分组',
    'list.capturedAria': '已抓取的 flow',
    'list.count': '{shown} / {total} 个 flow',
    'list.empty.title': '等待流量',
    'list.empty.hint': '把设备或应用的代理指向这个地址：',
    'list.empty.copy': '复制代理地址',
    'list.splitterAria': '调整 flow 列表宽度',
    'list.splitterTitle': '拖动调整 flow 列表宽度',
    'list.treeHint': '分组已折叠 — 点击主机展开。用 ⊞ / ⊟ 全部展开或折叠。',
    'list.tagMock': 'Mock',
    'list.tagTunnel': '隧道',
    'list.tagErr': '错误',

    // --- flow list tree ---
    'tree.hostTitle': '{host} — {n} 个请求',
    'tree.pathTitle': '{host}{path} — {n} 个请求',
    'tree.unknownHost': '（未知主机）',
    'tree.unset': '（未设置）',
    'tree.items': '{n} 项',
    'tree.entries': '{n} 项',
    'tree.emptyMessage': '空 message',
    'tree.empty': '（空）',

    // --- detail: empty state, tabs, header ---
    'detail.empty.title': '选择一个 flow',
    'detail.empty.hint': '在左侧选择一条请求，查看请求头和解码后的 body。',
    'detail.empty.pbHint': 'Protobuf 响应以带类型的字段树展示，不转成 JSON。',
    'detail.tab.summary': '概览',
    'detail.tab.request': '请求',
    'detail.tab.response': '响应',
    'detail.copyUrl': '复制 URL',
    'detail.reqSize': '请求 {size}',
    'detail.respSize': '响应 {size}',
    'detail.mocked': '已 Mock',
    'detail.patched': '已 patch',
    'detail.notDecrypted': '未解密',
    'detail.reqHeaders': '请求头',
    'detail.resHeaders': '响应头',
    'detail.reqBody': '请求 body',
    'detail.resBody': '响应 body',
    'detail.matchedRules': '命中的规则',
    'detail.queryCount': 'Query ({n})',
    'detail.noReqHeaders': '（无请求头）',
    'detail.noResHeaders': '（无响应头）',
    'detail.truncated': '（已截断）',
    'detail.mode.decoded': '解码',
    'detail.mode.raw': '原始',
    'detail.mode.hex': 'Hex',
    'detail.mode.patched': '已 patch',
    'detail.mode.original': '原始',
    'detail.card.overview': '概览',
    'detail.card.timing': '耗时明细',
    'detail.card.notDecrypted': '未解密',
    'card.expand': '展开 {title}',
    'card.collapse': '收起 {title}',

    // --- key/value labels (overview, tunnel metadata, timing) ---
    'kv.method': '方法',
    'kv.status': '状态',
    'kv.url': 'URL',
    'kv.originalUrl': '原始 URL',
    'kv.request': '请求',
    'kv.response': '响应',
    'kv.duration': '耗时',
    'kv.reqBytes': '请求大小',
    'kv.resBytes': '响应大小',
    'kv.contentEncoding': 'content-encoding',
    'kv.started': '开始时间',
    'kv.flowId': 'flow ID',
    'kv.reason': '原因',
    'kv.connect': '连接',
    'kv.error': '错误',
    'kv.bytesUp': '上行字节',
    'kv.bytesDown': '下行字节',
    'kv.closed': '关闭方',
    'kv.client': '客户端',
    'kv.start': '开始',
    'kv.upstreamConnected': '上游连接完成',
    'kv.firstByte': '首字节',
    'kv.complete': '完成',

    // --- diagnostic banners (patch_error/decode_error stay verbatim) ---
    'problem.error': '错误',
    'problem.patchError': 'patch_error',
    'problem.decodeError': 'decode_error',
    'problem.reqDecode': '请求解码',
    'problem.resDecode': '响应解码',
    'problem.note': '提示',
    'problem.truncatedNote': '响应 body 在记录上限处被截断，解码结果可能不完整。',

    // --- why a CONNECT was not decrypted ---
    'tunnel.bypass': '该主机命中 proxy.bypass，pbmockx 只建立了原始 TCP 隧道，看不到明文。要抓包并 Mock 它，请删除（或缩小）该 bypass 条目。',
    'tunnel.mitmDisabled': 'proxy.mitm 全局为 false，所有 HTTPS 连接都只做隧道、不解密。请在 config.json 里设置 "mitm": true。',
    'tunnel.port': '该 CONNECT 端口不在 proxy.mitmPorts 中（默认 443、8443），因此隧道没有被拦截。把该端口加进去即可抓包。',
    'tunnel.tlsHandshake': 'CONNECT 已被拦截，但 TLS 握手失败。常见原因：客户端未安装或不信任该 CA、应用做了证书校验（pinning）、要求 mTLS，或者根本不使用 TLS/HTTP。',
    'tunnel.caError': 'pbmockx 无法为该主机签发叶子证书 — 请检查数据目录权限和 CA 文件。',

    // --- bodies ---
    'body.notAvailable': 'body 不可用（HTTP {status}）',
    'body.moreBytes': '… 还有 {n} 字节',
    'body.truncatedForDisplay': '…（显示已截断）',
    'body.noData': '暂无数据',
    'body.notDecodable': 'body 无法解码（请查看 Raw/Hex）',
    'body.empty': '（body 为空）',

    // --- shared buttons / states ---
    'common.copy': '复制',
    'common.download': '下载',
    'common.copied': '已复制',
    'common.copyFailed': '复制失败',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.reload': '重新加载',
    'common.closeEsc': '关闭（Esc）',
    'common.loading': '加载中…',
    'common.emptyParen': '（空）',

    // --- drawer ---
    'drawer.tabRules': 'Mock 规则',
    'drawer.tabSetup': '设置与 CA',

    // --- confirmations / toasts ---
    'confirm.clearFlows': '清空所有已抓取的 flow？',
    'toast.flowsCleared': '已清空 flow',

    // --- rules panel ---
    'rules.add': '+ 添加规则',
    'rules.addTitle': '添加 Mock 规则',
    'rules.addSubmit': '添加规则',
    'rules.added': '规则已添加',
    'rules.saved': 'rules.yaml 已保存',
    'rules.reloaded': '已重新加载 {n} 条规则',
    'rules.empty': '还没有规则。添加一条 patch 规则即可修改响应字段。',
    'rules.typePatch': 'Patch',
    'rules.typeMapLocal': 'Map local',
    'rules.typeMapRemote': 'Map remote',
    'rules.enable': '启用规则',
    'rules.disable': '禁用规则',
    'rules.editMock': '编辑 Mock 数据',
    'rules.delete': '删除规则',
    'rules.deleteConfirm': '删除规则 {id}？',
    'rules.deleted': '规则已删除',
    'rules.fieldType': '规则类型',
    'rules.fieldUrlPattern': 'URL 模式（正则）',
    'rules.phUrlPattern': 'URL 正则，例如 api/game',
    'rules.typeOption.patch': 'Patch — 修改响应字段',
    'rules.typeOption.mapLocal': 'Map local — 整体替换响应',
    'rules.typeOption.mapRemote': 'Map remote — 改写请求 URL',
    'rules.fieldPath': '路径',
    'rules.phPath': '字段路径，例如 game.name',
    'rules.fieldAction': '操作',
    'rules.action.set': 'set（替换）',
    'rules.action.append': 'append',
    'rules.action.insert': 'insert',
    'rules.action.remove': 'remove',
    'rules.action.unset': 'unset（删除键）',
    'rules.fieldIndex': '索引（可选）',
    'rules.phIndex': '索引（insert/remove）',
    'rules.fieldProtocol': '协议（可选）',
    'rules.protocol.both': '两者',
    'rules.fieldValue': '值',
    'rules.phValue': 'JSON 值，例如 "Mocked" / 999 / {"k":"v"} / false',
    'rules.fieldSource': '来源',
    'rules.source.data': 'data — JSON 编码为 protobuf',
    'rules.source.file': 'file — 返回本地文件字节',
    'rules.fieldStatus': '状态码（可选）',
    'rules.phStatus': '覆盖状态码，例如 200',
    'rules.fieldDesc': 'desc（可选）',
    'rules.phDesc': 'desc URL（PB 可选）',
    'rules.fieldMessageType': 'messageType（可选）',
    'rules.phMessageType': 'messageType（PB 可选）',
    'rules.fieldMockData': 'Mock 数据（JSON）',
    'rules.phMockData': 'JSON body，例如 {"game":{"name":"Mocked"}}',
    'rules.fieldFilePath': '本地文件路径',
    'rules.phFilePath': '/absolute/path/to/mock.bin',
    'rules.fieldReplacement': '替换为',
    'rules.phReplacement': 'https://new.example.com/path 或 127.0.0.1:9101/path',
    'rules.regexLabel': '把替换内容按正则处理',
    'rules.editTitle': '编辑 {file}',
    'rules.mockSaved': 'Mock 数据已保存',
    'rules.invalidJson': 'JSON 无效：{msg}',
    'rules.metaUnset': 'value: （未设置）',
    'rules.errUrlPattern': 'URL 模式不能为空',
    'rules.errPath': '路径不能为空',
    'rules.errValue': 'set 操作必须提供值',
    'rules.errMockJson': 'Mock 数据必须是合法 JSON：{msg}',
    'rules.errFile': '文件路径不能为空',
    'rules.errUrlReplacement': 'URL 和替换内容不能为空',

    // --- setup / CA panel ---
    'setup.proxy': '代理',
    'setup.proxyNote': '把设备或浏览器的 HTTP 代理指向这个地址。HTTPS 流量通过本地 CA 抓取。',
    'setup.thisMachineIp': '<本机 IP>',
    'setup.lanNote': '已绑定 0.0.0.0 — 同一局域网的设备可以使用该代理并打开 UI。请仅在可信网络中使用。',
    'setup.otherAddresses': '其他地址：{list}',
    'setup.lanUiDisabled': '局域网 UI 访问已禁用（ui.lanAccess=false）；代理仍可用，但 UI/API 只允许本机访问。',
    'setup.notDecrypted': '未解密',
    'setup.notDecryptedNote': '只有 CONNECT 命中下列规则时才会解密 HTTPS。其余连接以原始 TCP 隧道方式转发，在 flow 列表里只显示一条仅含元数据的“隧道”记录。',
    'setup.mitm': 'MITM',
    'setup.mitmOff': '已禁用（proxy.mitm=false）',
    'setup.enabled': '已启用',
    'setup.ports': '端口',
    'setup.allPorts': '全部端口',
    'setup.bypass': 'bypass',
    'setup.none': '（无）',
    'setup.tunnelRecords': '隧道记录',
    'setup.tunnelRecordsOff': '已关闭（proxy.recordTunnels=false）',
    'setup.on': '开',
    'setup.ca': '证书颁发机构',
    'setup.file': '文件',
    'setup.subject': '主题',
    'setup.sha256': 'SHA-256',
    'setup.androidHash': 'Android 哈希',
    'setup.valid': '有效期',
    'setup.downloadCa': '下载 CA（.crt）',
    'setup.copyPath': '复制路径',
    'setup.caTrustNote': '在需要抓取 HTTPS 流量的设备上信任该 CA。用完后请删除。',
    'setup.caMissing': 'CA 尚不可用。请先启动守护进程：pbmockx start',
    'setup.installCa': '安装 CA',
    'setup.stepMac1': '下载上方的 CA（.crt）。',
    'setup.stepMac2': '在“钥匙串访问”中打开 <code>pbmockx-ca.crt</code> → 系统 → <b>始终信任</b>。',
    'setup.stepMac3': '或者：<code>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain pbmockx-ca.crt</code>',
    'setup.stepWin1': '下载 CA，然后以管理员身份运行 <code>certutil -addstore -f "ROOT" pbmockx-ca.crt</code>。',
    'setup.stepLinux1': '<code>sudo cp pbmockx-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</code>',
    'setup.stepLinux2': 'Chrome/Electron 应用还需要在 设置 → 隐私和安全 → 管理证书 → 授权机构 中导入。',
    'setup.stepAndroid1': '打开 USB 调试，然后运行 <code>pbmockx connect-android</code> 设置 <code>adb reverse</code> + <code>http_proxy</code>。',
    'setup.stepAndroid2': 'Android 7+ 的应用不信任用户证书 — 请安装为系统证书（root / Magisk）或使用模拟器。',
    'setup.stepAndroid3': '下载地址：<code>/__pbmockx/api/ca.pem</code>',
    'setup.dataLimits': '数据与上限',
    'setup.dataDir': '数据目录',
    'setup.rulesFile': 'rules.yaml',
    'setup.mockData': 'mock-data',
    'setup.maxFlows': 'flow 数量上限',
    'setup.recordBodyCap': '记录 body 上限',
    'setup.totalRecordCap': '记录总大小上限',
    'setup.rewriteBodyCap': '改写 body 上限',
  },
};

export function normalizeLang(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase().replace(/_/g, '-').split('.')[0];
  if (!v) return null;
  if (v === 'zh' || v.startsWith('zh-')) return 'zh';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return null;
}

export function getLang() {
  return lang;
}

/**
 * Translate a key. `{name}` placeholders are substituted from `vars`.
 * A missing key falls back to the English catalog, then to the key itself, and
 * is recorded so tests / the smoke run can catch gaps.
 */
export function t(key, vars) {
  const table = dict[lang] || dict.en;
  let s = table[key];
  if (s === undefined) {
    missing.add(key);
    s = dict.en[key] !== undefined ? dict.en[key] : key;
  }
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  }
  return s;
}

export function missingKeys() {
  return [...missing];
}

function translateElement(el) {
  const key = el.getAttribute('data-i18n');
  if (key) el.textContent = t(key);
  const title = el.getAttribute('data-i18n-title');
  if (title) el.title = t(title);
  const aria = el.getAttribute('data-i18n-aria');
  if (aria) el.setAttribute('aria-label', t(aria));
  const ph = el.getAttribute('data-i18n-placeholder');
  if (ph) el.setAttribute('placeholder', t(ph));
}

/** Translate every [data-i18n*] node under `root`. */
export function applyStatic(root = document) {
  const nodes = root.querySelectorAll
    ? root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-aria],[data-i18n-placeholder]')
    : [];
  nodes.forEach(translateElement);
  if (root.documentElement) root.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.title');
}

export function setLang(next, { persist = true, apply = true } = {}) {
  const normalized = normalizeLang(next) || 'en';
  lang = normalized;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, normalized); } catch { /* private mode */ }
  }
  if (apply) applyStatic(document);
  return lang;
}

/** Language to start with, before the server default is known. */
export function resolveInitialLang() {
  let query = null;
  try { query = new URLSearchParams(location.search).get('lang'); } catch { /* no location */ }
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  return normalizeLang(query) || normalizeLang(stored) || normalizeLang(navigator.language) || 'en';
}

/**
 * Apply the initial language. `serverLang` comes from /__pbmockx/api/health and
 * only matters when neither ?lang= nor a stored choice is present.
 */
export function initLang(serverLang) {
  let query = null;
  try { query = new URLSearchParams(location.search).get('lang'); } catch { /* no location */ }
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  const initial = normalizeLang(query) || normalizeLang(stored) || normalizeLang(serverLang) || normalizeLang(navigator.language) || 'en';
  return setLang(initial, { persist: false });
}

/** Wire a button so it flips between en and zh. */
export function mountLangToggle(button) {
  if (!button) return;
  const render = () => {
    button.textContent = t('lang.switch');
    button.title = t('lang.title');
    button.setAttribute('aria-label', t('lang.title'));
  };
  button.addEventListener('click', () => {
    setLang(lang === 'zh' ? 'en' : 'zh');
    render();
  });
  render();
}
