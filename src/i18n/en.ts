/**
 * CLI message catalog (English). This file is the source of truth for key names:
 * `zh.ts` is typed as `Record<MsgKey, string>`, so a missing translation is a
 * compile error rather than a runtime surprise.
 *
 * Conventions:
 *   - `{name}` placeholders are substituted by t(key, { name }).
 *   - Structural/machine output stays English in both languages: table headers,
 *     `=== Request ===` markers, `OK/WARN/FAIL`, `--json` keys and values.
 *   - Keys are `area.thing`, e.g. `rules.added`, `doctor.hint`, `help.main`.
 *   - Help blocks are single keys holding the whole text; command names, flags
 *     and the `Usage:` line stay verbatim inside them.
 *   - Leading indentation inside a value is deliberate (block layout); values
 *     never end with a space.
 */

export const en = {
  // --- version / shared ---
  'cli.version': 'pbmockx {version}',

  // --- help (one key per command; the Usage line and flags stay English) ---
  'help.main': `Usage: pbmockx <command> [args] [options]

Capture & inspect:
  flows [--filter <regex>] [--json]        List captured flows
  decode <id> [options] [--json]           Show headers + decoded body

Mock rules:
  rules add <url> <path> <value>           Add a patch rule
  rules add <url> <path> --append <value>  Append to a repeated field
  rules add <url> <path> --insert <idx> <value>
  rules add <url> <path> --remove <idx>
  rules add <url> <path> --unset           Delete the key at <path>
  rules list [--type patch|map_local|map_remote] [--json]
  rules del <id> | save | reload
  map-local add <url> --data <json>|--file <path>
  map-local list | del <id>
  map-remote add <url> <replacement> [--regex]
  map-remote list | del <id>

Daemon:
  start [--port <n>] [--host <h>] [--lan] [--foreground]
  stop | restart | status [--json]
  logs [-f] [-n <lines>]
  web                                      Open the Web UI
  ca [--out <file>] [--info] [--regen --yes]

Device:
  connect-android [-s <serial>] [--wifi [host]]  Configure Android proxy + cert status

Maintenance:
  doctor [--json]                          Health check (daemon, CA, rules)
  fix                                      Rebuild + restart the daemon
  agent-doc                                Print SKILL.md
  skill install|list|uninstall             Install agent docs
  version [--check]                        Show version / check releases

Options:
  -h, --help                               Show help (use with a subcommand)
  --json                                   Machine-readable output where supported
  --lang <zh|en>                           Output language (default: system locale)

Run 'pbmockx <command> --help' for command-specific help.`,

  'help.flows': `Usage: pbmockx flows [--filter <regex>] [--json]

List captured flows (one row per request; request and response share an id).
Rows with proto=tunnel are CONNECT connections pbmockx did not decrypt (bypass,
port not in mitmPorts, or a failed TLS handshake); 'decode <id>' prints why.

Options:
  --filter <regex>   Filter by URL regex
  --json             Print the raw API list as JSON
  -h, --help         Show this help

Examples:
  pbmockx flows
  pbmockx flows --filter api/game`,

  'help.decode': `Usage: pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full] [--headers] [--json]

Show flow headers + decoded body (PB field tree or JSON).

Arguments:
  id                 Flow id (or unique prefix) from 'pbmockx flows'

Options:
  --req              Show only the request
  --res              Show only the response
  --original         Show the pre-patch response
  --path <path>      Navigate to a subtree (e.g. data.list[0].app)
  --full             Expand every field (default: collapsed)
  --headers          Keep method/url/headers with --path/--full
  --json             Print the raw API detail as JSON
  -h, --help         Show this help

Default output is collapsed to save tokens: nested messages show
(type, N fields) and repeated fields show (repeated type, N items).`,

  'help.rules': `Usage: pbmockx rules <subcommand> [args]

Subcommands:
  add <url> <path> <value> [--protocol pb|json]   Replace a field
  add <url> <path> --append <value>               Append to a repeated field
  add <url> <path> --insert <idx> <value>         Insert at index
  add <url> <path> --remove <idx>                 Remove at index
  add <url> <path> --unset                        Delete the key
  list [--type patch|map_local|map_remote] [--json]
  del <id>
  save
  reload

Examples:
  pbmockx rules add 'api/game' game.name Mocked --protocol pb
  pbmockx rules add 'api/game' game.tags --append '{"k":"v"}'
  pbmockx rules add 'api/game' game.obsolete --unset
  pbmockx rules list --type patch`,

  'help.mapLocal': `Usage: pbmockx map-local <subcommand> [args]

Subcommands:
  add <url> --data '<json>' [--desc <url>] [--messageType <type>] [--delimited] [--status <code>]
  add <url> --file <path> [--status <code>]
  list
  del <id>

Options:
  --data <json>          Inline mock data (stored in mock-data/<id>.json)
  --file <path>          Serve a local file as the response body
  --desc <url>           .desc URL for PB encoding
  --messageType <type>   PB message type
  --delimited            Length-delimited PB framing
  --status <code>        Override HTTP status
  -h, --help             Show this help`,

  'help.mapRemote': `Usage: pbmockx map-remote <subcommand> [args]

Subcommands:
  add <url> <replacement> [--regex]
  list
  del <id>

A replacement without a scheme is treated as https:// (whistle-compatible).

Options:
  --regex        Treat <replacement> as a regex replacement
  -h, --help     Show this help`,

  'help.start': `Usage: pbmockx start [--port <n>] [--host <h>] [--lan] [--foreground]

Start the pbmockx daemon (proxy + control API + Web UI on one port).

Options:
  --port <n>     Listen port (default: config or 8899)
  --host <h>     Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN devices)
  --lan          Shorthand for --host 0.0.0.0 and UI/API LAN access
  --foreground   Run in the foreground (Ctrl+C to stop)
  -h, --help     Show this help

LAN access is enabled by default when bound to 0.0.0.0; set
"ui": { "lanAccess": false } in config.json to expose only the proxy.`,

  'help.restart': `Usage: pbmockx restart [--port <n>] [--host <h>] [--lan]

Restart the daemon (uses the current runtime port/host unless overridden).`,

  'help.stop': `Usage: pbmockx stop

Stop the daemon (SIGTERM, then SIGKILL if needed).`,

  'help.status': `Usage: pbmockx status [--json]

Show daemon status, port, uptime, flow and rule counts.`,

  'help.logs': `Usage: pbmockx logs [-f] [-n <lines>]

Show the daemon log (default: last 80 lines).

  -f           Follow appended lines
  -n <lines>   Number of lines to print first`,

  'help.ca': `Usage: pbmockx ca [--out <file>] [--info] [--regen --yes]

Show CA details and install instructions.

Options:
  --out <file>   Write the CA certificate to <file>
  --info         Print CA info as JSON
  --regen        Regenerate the CA (requires --yes; devices must re-trust it)
  -h, --help     Show this help`,

  'help.web': `Usage: pbmockx web

Open the pbmockx Web UI in the default browser.`,

  'help.connectAndroid': `Usage: pbmockx connect-android [-s <serial>] [--wifi [host]]

Configure an Android device to use pbmockx as its HTTP proxy (adb reverse +
global http_proxy by default; --wifi uses the LAN address instead) and detect
the CA install status.

Status values: system | user | not_found | unknown.
The user-cert directory is SELinux-protected, so on non-root devices the CA
status cannot be confirmed automatically (unknown) — check Settings manually.
System certificates require root / Magisk; this command never modifies certs.

Options:
  -s <serial>   Target a specific adb device
  --wifi [host] Use a LAN proxy instead of adb reverse (default: first LAN IP)
  -h, --help    Show this help

Run pbmockx with --lan (or --host 0.0.0.0) first so LAN devices can connect.`,

  'help.doctor': `Usage: pbmockx doctor [--json]

Check Node version, data directory, CA, daemon health, rules and agent docs.
If the daemon is not reachable, run 'pbmockx fix'.`,

  'help.fix': `Usage: pbmockx fix

Rebuild the TypeScript output, restart the daemon and verify health.
Use when the daemon does not start or the UI/API is unreachable.`,

  'help.agentDoc': `Usage: pbmockx agent-doc

Print SKILL.md (the AI-agent usage guide).`,

  'help.skill': `Usage: pbmockx skill <install|list|uninstall>

Manage SKILL.md in ~/.agents/skills/ and ~/.claude/skills/.`,

  'help.version': `Usage: pbmockx version [--check]

Show the version (optionally check GitHub releases).`,

  // --- rules / map-* ---
  'rules.added': 'Rule added: {id} {url} {path} => {value}',
  'rules.deleted': 'Deleted: {ok}',
  'rules.saved': 'Saved: {ok}',
  'rules.reloaded': 'Reloaded: {count} rules',
  'mapLocal.added': 'Map local added: {id} {url}',
  'mapRemote.added': 'Map remote added: {id} {url} => {replacement}',

  // --- web ---
  'web.opening': 'Opening {url}',
  'web.openManual': 'Open manually: {url}',

  // --- errors (the "Error: " prefix itself stays English) ---
  'error.dataInvalidJson': '--data must be valid JSON: {message}',
  'error.dataOrFile': 'Either --data or --file is required',
  'error.daemonDown': 'pbmockx daemon is not running on 127.0.0.1:{port}. Run: pbmockx start',
  'error.unknownCommand': 'Unknown command: {command}',
  'error.runHelp': 'Run: pbmockx --help',

  // --- connect-android ---
  'connect.noLanIp': 'no non-internal IPv4 address found for --wifi; pass an explicit host.',
  'connect.adbMissing': 'adb not available. Install platform-tools and ensure adb is in PATH.',
  'connect.noDevice': 'no adb device connected. Connect a device with USB debugging on.',
  'connect.multipleDevices': '{count} adb devices connected — specify one with -s <serial>.',
  'connect.availableDevices': 'Available devices:',
  'connect.deviceEntry': '  {serial} ({state})',
  'connect.deviceNotReady': 'device {serial} is {state} (not ready).',
  'connect.authorizeRsa': 'Authorize the RSA fingerprint on the device, or reconnect and retry.',
  'connect.execFailed': 'failed: {message}',
  'connect.step1': '=== Step 1: Configure proxy (executed) ===',
  'connect.step2': '=== Step 2: Detect status (read-only) ===',
  'connect.wifiMode': 'Wi-Fi mode: using {host}:{port} (no adb reverse)',
  'connect.proxy': 'Proxy: {state}{raw}{expected}',
  'connect.proxyExpected': ' (expected {expected})',
  'connect.caHash': 'CA hash: {hash}',
  'connect.certStatusNoCa': 'Cert status:   unknown (CA not generated yet — run: pbmockx start)',
  'connect.certSystem': 'Cert (system): {status}',
  'connect.certUser': 'Cert (user):   {status}',
  'connect.certStatus': 'Cert status:   {state}',
  'connect.certReadFailed': 'Cert status:   unknown (CA read failed: {message})',
  'connect.certFoundAt': 'found @ {dir}',
  'connect.certPermissionDenied': 'cannot check (permission denied)',
  'connect.certNotFound': 'not found',
  'connect.certRequiresRoot': 'requires root (su) to check',
  'connect.warnUserTitle': '  WARNING: installed as USER certificate.',
  'connect.warnUserBody1': '  Android 7+ apps (targetSdk>=24) do NOT trust user certs by default.',
  'connect.warnUserBody2': '  Install as a SYSTEM cert (root / Magisk / emulator) or configure',
  'connect.warnUserBody3': '  networkSecurityConfig in the app.',
  'connect.manualTitle': '  Manual steps to install (NOT executed by this command):',
  'connect.manualStep1': '  1. Download: http://{host}:{port}/__pbmockx/api/ca.pem',
  'connect.manualStep2': '  2. adb push {file} /sdcard/pbmockx-ca.crt',
  'connect.manualStep3': '  3. Settings > Security > Encryption & credentials > Install from storage',
  'connect.rerun': '  Re-run: pbmockx connect-android{serial}  (after install)',
  'connect.unknownTitle': '  Cannot automatically confirm cert status:',
  'connect.unknownSystemCert': '  - System cert: not installed',
  'connect.unknownUserCert1': '  - User cert:   cannot check without root (su) — the user-cert',
  'connect.unknownUserCert2': '    directory is protected by SELinux on non-root devices.',
  'connect.unknownOffline': '  (permission denied or device offline)',
  'connect.unknownVerify1': '  Verify manually: Settings > Security > Encryption & credentials >',
  'connect.unknownVerify2': '    Trusted credentials > User tab (look for "pbmockx local CA").',
  'connect.unknownNote1': '  Note: a USER cert is NOT trusted by apps targeting Android 7+ unless',
  'connect.unknownNote2': '  the app uses networkSecurityConfig. For reliable HTTPS capture, install',
  'connect.unknownNote3': '  as a SYSTEM cert (root / Magisk) or use an emulator.',
  'connect.systemOk': '  Cert installed as SYSTEM certificate — apps should trust it.',

  // --- doctor (rows keep English names/details in --json; only text is translated) ---
  'doctor.row': '{tag} {label}: {detail}',
  'doctor.version': 'version: {version}',
  'doctor.name.node': 'node',
  'doctor.name.dataDir': 'data dir',
  'doctor.name.ca': 'CA',
  'doctor.name.daemon': 'daemon',
  'doctor.name.traffic': 'traffic',
  'doctor.name.fix': 'fix',
  'doctor.name.legacy': 'legacy whistle',
  'doctor.name.skill': 'skill',
  'doctor.daemonDown': 'pbmockx daemon is not running on 127.0.0.1:{port}. Run: pbmockx start',
  'doctor.nodeNeed': ' (need >= 18)',
  'doctor.caPending': 'not generated yet (run: pbmockx start)',
  'doctor.trafficWarn': 'no flows captured yet — configure the proxy and trigger a request',
  'doctor.fixHint': 'run: pbmockx fix',
  'doctor.legacyInstalled': '{version} installed — pbmockx no longer uses it; stop it if it occupies port {port}',
  'doctor.legacyAbsent': 'not installed',
  'doctor.skillNotSymlink': '{path} is not a symlink (run: pbmockx skill install)',
  'doctor.skillOk': '{path} -> {target}',
  'doctor.skillBroken': '{path} broken -> {target}',
  'doctor.skillMissing': '{path} not installed (run: pbmockx skill install)',
  'doctor.next': 'Next: pbmockx fix   (rebuild + restart + verify)',

  // --- fix ---
  'fix.step1': '[1/3] Building...',
  'fix.noSources': 'this install has no TypeScript sources (installed from npm).',
  'fix.upgrade': 'upgrade instead: npm i -g pbmockx@latest && pbmockx restart',
  'fix.installingDeps': 'node_modules missing — installing dependencies...',
  'fix.buildOk': 'build OK',
  'fix.buildFailed': 'build failed: {message}',
  'fix.step2': '[2/3] Restarting daemon...',
  'fix.restartFailed': 'restart failed: {message}',
  'fix.step3': '[3/3] Verifying...',
  'fix.notHealthy': 'daemon is not healthy. Last log lines:',
  'fix.ok': 'OK — daemon healthy | flows: {flows} | rules: {rules}',

  // --- skill ---
  'skill.dirMissing': 'skill dir not found at {dir}',
  'skill.installed': 'Installed: {target} -> {source}',
  'skill.failed': 'Failed: {target} {message}',
  'skill.found': 'Found: {path} -> {target}',
  'skill.foundNotSymlink': 'Found (not symlink): {path}',
  'skill.removed': 'Removed: {path}',

  // --- version --check ---
  'version.updateAvailable': 'Latest: {latest} (update available)',
  'version.upToDate': 'Up to date',
  'version.checkFailed': 'Remote check failed: {message}',

  // --- decode: tunnel flow ---
  'tunnel.header': '=== Tunnel (not decrypted) ===',
  'tunnel.reason': 'reason: {reason}',
  'tunnel.error': 'error: {error}',
  'tunnel.bytes': 'bytes: up {up}  down {down}',
  'tunnel.closed': 'closed: {by}',
  'tunnel.client': 'client: {ip}',
  'tunnel.flowId': 'flow id: {id}',

  // --- decode: body rendering (=== Request/Response === markers stay English) ---
  'render.none': '(none)',
  'render.decodeError': '(decode error: {message})',
  'render.empty': '(empty)',
  'render.pathNotFound': 'Path not found: {path}',
  'render.availableFields': 'Available top-level fields: {fields}',

  // --- start ---
  'start.alreadyRunning': 'pbmockx is already running at http://{host}:{port} (pid {pid})',
  'start.lanLine': '  LAN: http://{ip}:{port}/',
  'start.foreground': 'pbmockx daemon running at http://{host}:{port} (Ctrl+C to stop)',
  'start.failed': 'pbmockx failed to start. Last log lines:',
  'start.started': 'pbmockx started (pid {pid})',
  'start.proxyLine': '  proxy : {host}:{port}',
  'start.uiLine': '  UI    : http://{host}:{port}/',
  'start.lanAddress': '  LAN   : http://{ip}:{port}/  (proxy {ip}:{port})',
  'start.lanNote1': 'LAN note: devices on this network can open the UI and read captured traffic.',
  'start.lanNote2': '          Set ui.lanAccess=false in config.json to expose only the proxy.',
  'start.noLanIp': '  LAN   : no non-internal IPv4 address detected',
  'start.dataLine': '  data  : {dir}',
  'start.caLine': '  CA    : {file}',
  'start.next': 'Next: install the CA on your device (pbmockx ca), then configure the proxy above.',

  // --- stop ---
  'stop.notRunning': 'pbmockx is not running',
  'stop.failed': 'stop failed: {message}',
  'stop.stopped': 'pbmockx stopped',

  // --- status ---
  'status.daemonRunning': 'Daemon: running (pid {pid}) http://{host}:{port}',
  'status.uptime': 'Uptime: {uptime} | flows: {flows} | rules: {rules}',
  'status.ui': 'UI:     http://{host}:{port}/',
  'status.lan': 'LAN:    http://{ip}:{port}/  (proxy {ip}:{port})',
  'status.notRunning': 'Daemon: not running',
  'status.start': 'Start:  pbmockx start{dataDir}',

  // --- ca ---
  'ca.regenNeedsYes': 'Refusing to regenerate the CA without --yes (all devices will need to re-trust it).',
  'ca.regenerated': 'CA regenerated at {file}',
  'ca.restarting': 'Restarting daemon to load the new CA...',
  'ca.generated': 'Generated CA at {file}',
  'ca.restartToLoad': 'Restart the daemon to load it: pbmockx restart',
  'ca.wrote': 'Wrote CA certificate to {file}',
  'ca.certificate': 'CA certificate: {file}',
  'ca.subject': 'Subject      : {subject}',
  'ca.sha256': 'SHA-256      : {fingerprint}',
  'ca.androidHash': 'Android hash : {hash}',
  'ca.valid': 'Valid        : {notBefore} -> {notAfter}',
  'ca.installTitle': 'Install it on the client device:',
  'ca.download': '  download  : http://127.0.0.1:{port}/__pbmockx/api/ca.pem',
  'ca.copyFile': '  copy file : pbmockx ca --out ./pbmockx-ca.crt',
  'ca.android': 'Android: pbmockx connect-android   (proxy + cert status; system cert needs root/Magisk)',
} as const;

export type MsgKey = keyof typeof en;
