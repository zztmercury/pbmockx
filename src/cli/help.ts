/**
 * CLI help text. Every command supports -h/--help.
 */

export function helpMain(): void {
  console.log(`Usage: pbmockx <command> [args] [options]

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

Run 'pbmockx <command> --help' for command-specific help.`);
}

export function helpFlows(): void {
  console.log(`Usage: pbmockx flows [--filter <regex>] [--json]

List captured flows (one row per request; request and response share an id).
Rows with proto=tunnel are CONNECT connections pbmockx did not decrypt (bypass,
port not in mitmPorts, or a failed TLS handshake); 'decode <id>' prints why.

Options:
  --filter <regex>   Filter by URL regex
  --json             Print the raw API list as JSON
  -h, --help         Show this help

Examples:
  pbmockx flows
  pbmockx flows --filter api/game`);
}

export function helpDecode(): void {
  console.log(`Usage: pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full] [--headers] [--json]

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
(type, N fields) and repeated fields show (repeated type, N items).`);
}

export function helpRules(): void {
  console.log(`Usage: pbmockx rules <subcommand> [args]

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
  pbmockx rules list --type patch`);
}

export function helpMapLocal(): void {
  console.log(`Usage: pbmockx map-local <subcommand> [args]

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
  -h, --help             Show this help`);
}

export function helpMapRemote(): void {
  console.log(`Usage: pbmockx map-remote <subcommand> [args]

Subcommands:
  add <url> <replacement> [--regex]
  list
  del <id>

A replacement without a scheme is treated as https:// (whistle-compatible).

Options:
  --regex        Treat <replacement> as a regex replacement
  -h, --help     Show this help`);
}

export function helpStart(): void {
  console.log(`Usage: pbmockx start [--port <n>] [--host <h>] [--lan] [--foreground]

Start the pbmockx daemon (proxy + control API + Web UI on one port).

Options:
  --port <n>     Listen port (default: config or 8899)
  --host <h>     Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN devices)
  --lan          Shorthand for --host 0.0.0.0 and UI/API LAN access
  --foreground   Run in the foreground (Ctrl+C to stop)
  -h, --help     Show this help

LAN access is enabled by default when bound to 0.0.0.0; set
"ui": { "lanAccess": false } in config.json to expose only the proxy.`);
}

export function helpRestart(): void {
  console.log(`Usage: pbmockx restart [--port <n>] [--host <h>] [--lan]\n\nRestart the daemon (uses the current runtime port/host unless overridden).`);
}

export function helpStop(): void {
  console.log(`Usage: pbmockx stop\n\nStop the daemon (SIGTERM, then SIGKILL if needed).`);
}

export function helpStatus(): void {
  console.log(`Usage: pbmockx status [--json]\n\nShow daemon status, port, uptime, flow and rule counts.`);
}

export function helpLogs(): void {
  console.log(`Usage: pbmockx logs [-f] [-n <lines>]\n\nShow the daemon log (default: last 80 lines).\n\n  -f           Follow appended lines\n  -n <lines>   Number of lines to print first`);
}

export function helpCa(): void {
  console.log(`Usage: pbmockx ca [--out <file>] [--info] [--regen --yes]

Show CA details and install instructions.

Options:
  --out <file>   Write the CA certificate to <file>
  --info         Print CA info as JSON
  --regen        Regenerate the CA (requires --yes; devices must re-trust it)
  -h, --help     Show this help`);
}

export function helpWeb(): void {
  console.log(`Usage: pbmockx web\n\nOpen the pbmockx Web UI in the default browser.`);
}

export function helpConnectAndroid(): void {
  console.log(`Usage: pbmockx connect-android [-s <serial>] [--wifi [host]]

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

Run pbmockx with --lan (or --host 0.0.0.0) first so LAN devices can connect.`);
}

export function helpDoctor(): void {
  console.log(`Usage: pbmockx doctor [--json]

Check Node version, data directory, CA, daemon health, rules and agent docs.
If the daemon is not reachable, run 'pbmockx fix'.`);
}

export function helpFix(): void {
  console.log(`Usage: pbmockx fix

Rebuild the TypeScript output, restart the daemon and verify health.
Use when the daemon does not start or the UI/API is unreachable.`);
}

export function helpAgentDoc(): void {
  console.log(`Usage: pbmockx agent-doc\n\nPrint SKILL.md (the AI-agent usage guide).`);
}

export function helpSkill(): void {
  console.log(`Usage: pbmockx skill <install|list|uninstall>\n\nManage SKILL.md in ~/.agents/skills/ and ~/.claude/skills/.`);
}

export function helpVersion(): void {
  console.log(`Usage: pbmockx version [--check]\n\nShow the version (optionally check GitHub releases).`);
}
