# pbmockx

[![npm version](https://img.shields.io/npm/v/pbmockx.svg?label=npm&logo=npm)](https://www.npmjs.com/package/pbmockx)
[![node](https://img.shields.io/node/v/pbmockx.svg?label=node&logo=node.js)](https://www.npmjs.com/package/pbmockx)
[![license](https://img.shields.io/npm/l/pbmockx.svg?label=license)](LICENSE)

English · [中文](README.md)

**A protobuf / JSON debugging tool with capture, mocking and a web UI built in** — no whistle required.

pbmockx runs an HTTP/HTTPS proxy on your machine. It recognises Charles-style
self-describing protobuf (`Content-Type: application/x-protobuf; desc="..."; messageType="..."`)
and JSON, renders responses as a field tree with type annotations, and lets you edit fields
by path. **Protobuf is never converted to JSON**, so there is no int64→string or
enum→string ambiguity — and both humans and AI agents get a first-class interface.

```
client / Android / curl ──proxy──► pbmockx (:8899)
                                     ├─ capture (HTTP / HTTPS MITM / WebSocket / SSE)
                                     ├─ mock (patch / map_local / map_remote)
                                     ├─ control API (used by the CLI)
                                     └─ web UI (live flows / field tree / rule editing)
```

## Features

- **Capture**: forwarding HTTP proxy, HTTPS CONNECT interception with its own CA, gzip/deflate/br, SSE streamed through untouched, WebSocket tunnelling, back-pressured forwarding of large bodies.
- **PB field tree**: `name#N (type) = value`, with field number and type; enums show number + name, bytes show base64 + byte count, `google.protobuf.Any` expands automatically by `type_url`, unset fields show `(unset)`.
- **Unified mocking** (identical behaviour for PB and JSON):
  - `patch`: edit fields by path; repeated fields support `--append/--insert/--remove`, `--unset` deletes a key, and paths can walk through `Any`.
  - `map_local`: replace the whole body (`--data` JSON is encoded to PB, or `--file` returns local bytes) with optional status code and response headers.
  - `map_remote`: redirect requests (wholesale replacement or regex), e.g. point a production endpoint at a local mock server.
- **Web UI**: live flow list, request/response detail, interactive field tree, patched ↔ original comparison, rule CRUD and enable/disable, mock data editing, CA download plus per-platform setup instructions.
- **AI-agent friendly**: the CLI collapses output by default to save tokens; `--path` drills into a subtree; every read command supports `--json`; SKILL.md can be injected straight into an agent.
- **No whistle dependency**: four runtime dependencies — `protobufjs`, `long`, `js-yaml`, `node-forge`.

## Install

Requires Node.js ≥ 18 (verified on macOS and Linux; Windows is untested).

### npm (recommended)

The package ships pre-compiled `dist/`, so no TypeScript toolchain is needed:

```bash
npm i -g pbmockx          # installs the pbmockx and pbmockxd commands
pbmockx start

npx pbmockx@latest start  # if you would rather not install globally
```

Upgrade with `npm i -g pbmockx@latest && pbmockx restart`; uninstall with `npm rm -g pbmockx`
(the data directory `~/.pbmockx` is left in place and must be removed manually).

### Install script (from source)

```bash
# one-liner from main
sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"

# or from a local checkout
./scripts/install.sh

# pin a branch or tag
PBMOCKX_REF=<branch-or-tag> \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/zztmercury/pbmockx/main/scripts/install.sh)"
```

The script checks Node, runs `npm install` + `tsc`, `npm link`s the global `pbmockx`
command (replacing an old whistle link), installs the agent skill, then runs `pbmockx restart`
and verifies the result.

- Code is installed to `~/.pbmockx/app`; data (rules, mocks, CA, logs) lives in `~/.pbmockx`. Override with `PBMOCKX_INSTALL_DIR` / `PBMOCKX_DATA_DIR`.
- If `pbmockx` in your shell still resolves to the old whistle plugin, run `hash -r` and check with `which -a pbmockx`.
- **Upgrading from the whistle plugin**: run `w2 stop` first to free port 8899, then run the installer. On first start in the default data directory, old `whistle-plugin/rules.yaml` and `mock-data/` are imported automatically. The new CA must be trusted again on every device.
- Uninstall: `./scripts/install.sh --uninstall`; add `--purge` to delete `~/.pbmockx` as well.

## Language (English / 中文)

The CLI and the web UI both speak English and Chinese, and **follow the system locale by default**
(`zh*` → Chinese, everything else → English):

```bash
pbmockx lang zh                  # persist it in config.json; a running daemon restarts
pbmockx lang                     # show the current language and where it came from
pbmockx lang auto                # go back to following the system locale
pbmockx --lang zh flows          # one command only (global flag, before or after the subcommand)
PBMOCKX_LANG=zh pbmockx doctor   # or via the environment
```

- Precedence: `--lang` > `PBMOCKX_LANG` > `"lang"` in `~/.pbmockx/config.json` > system locale > `en`.
- `pbmockx start --lang zh` passes the default language to the daemon, so the web UI opens in Chinese.
- The web UI has a 中文 / EN toggle in the top bar (remembered per browser); `?lang=zh` forces a language for one visit.
- Machine-facing output never changes: `--json`, table headers, `=== Request ===` markers and `OK/WARN/FAIL` stay English.

## Quick start

```bash
pbmockx start                 # proxy + control API + web UI (127.0.0.1:8899 by default)
pbmockx status                # running state / port / flow count
pbmockx ca                    # CA path, fingerprint and per-platform instructions
pbmockx ca --out ./pbmockx-ca.crt   # export the CA certificate
```

1. **Trust the CA** (required for HTTPS): install the certificate in your OS / browser / device. The **Setup & CA** panel in the UI has a one-click download and steps for macOS/Windows/Linux/Android.
2. **Point your client at the proxy**: HTTP/HTTPS proxy → `127.0.0.1:8899` (on Android, `pbmockx connect-android` does it for you).
3. **Open the web UI**: `pbmockx web`, or visit <http://127.0.0.1:8899/>.
4. Fire a request; it shows up in the list on the left. Open it to see request/response and the PB field tree.

### LAN devices (phone / another machine)

By default pbmockx only listens on `127.0.0.1`. To let devices on the same Wi-Fi/LAN reach it:

```bash
pbmockx start --lan            # same as --host 0.0.0.0 plus allowing LAN access to UI/API
# or
pbmockx start --host 0.0.0.0
```

The startup log prints the reachable LAN address (e.g. `http://192.168.1.23:8899/`).
Point the phone's HTTP/HTTPS proxy at `<LAN-IP>:8899` and open `http://<LAN-IP>:8899/` in a browser.

- On Android over Wi-Fi (rather than USB), use `pbmockx connect-android --wifi`; it picks up the local LAN IP automatically.
- To expose the proxy to LAN devices without exposing the UI/API, set `"ui": { "lanAccess": false }` in `~/.pbmockx/config.json`.
- **Only do this on a trusted network**: anyone on the same subnet can then read captured requests and responses. If the macOS firewall blocks inbound connections, allow `node` under “System Settings → Network → Firewall”.

```bash
# verify the whole chain with curl
curl -x http://127.0.0.1:8899 http://example.com/
curl -x http://127.0.0.1:8899 --cacert ~/.pbmockx/ca/ca.pem https://example.com/
```

## CLI (the main interface for AI agents)

```bash
# inspecting captured traffic
pbmockx flows [--filter <regex>] [--json]
pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full] [--headers] [--json]
# rows with proto=tunnel are CONNECT requests that were not decrypted (bypass / port / TLS
# handshake failure); decode prints the reason

# patch: edit response fields by path
pbmockx rules add 'api/game' game.name Mocked
pbmockx rules add 'api/game' game.id 999 --protocol pb
pbmockx rules add 'api/game' items --append '{"id":9}'       # repeated: append
pbmockx rules add 'api/game' items --insert 1 '{"id":8}'     # insert before index 1
pbmockx rules add 'api/game' items --remove 0                # drop index 0
pbmockx rules add 'api/game' game.obsolete --unset           # delete a key
pbmockx rules list [--type patch|map_local|map_remote] [--json]
pbmockx rules del <id> | save | reload

# map local: replace the whole body
pbmockx map-local add 'api/game' --data '{"game":{"name":"Mocked"}}'
pbmockx map-local add 'api/game' --file /path/to/mock.pb [--status 200]
pbmockx map-local list | del <id>

# map remote: redirect requests
pbmockx map-remote add 'api/old' 'https://new.example.com/new'
pbmockx map-remote add 'api/(.*)' 'https://mock.local/$1' --regex
pbmockx map-remote list | del <id>

# daemon
pbmockx start [--port 8899] [--host 127.0.0.1] [--lan] [--foreground]
pbmockx stop | restart | status [--json] | logs [-f] [-n 100]
pbmockx ca [--out <file>] [--info] [--regen --yes]

# maintenance
pbmockx doctor [--json]       # node / data dir / CA / daemon / rules / traffic
pbmockx fix                   # build + restart + verify
pbmockx agent-doc             # print SKILL.md
pbmockx skill install|list|uninstall
pbmockx version [--check]
pbmockx connect-android [-s <serial>] [--wifi [host]]
```

- Every command takes `-h/--help`; read commands take `--json`.
- `decode` is collapsed by default to save tokens: nested messages show `(type, N fields)`, repeated fields show `(repeated type, N items)`, long strings are truncated; use `--path` to drill down or `--full` to expand everything.
- `--original` shows the response before patching, which is handy for verifying a rule.

## Web UI

Visit <http://127.0.0.1:8899/>:

- Left: live flow list with method, status, URL, protocol, duration, size, and mock/error/ws markers; regex or plain-text filter, pause, clear, `j/k` navigation.
- **Flat / Tree views**: Tree groups requests by host and URL path (repeated calls to the same endpoint collapse into a count), starts fully collapsed, expands level by level, and remembers what you opened; the group containing the selected flow gets a blue marker. Long URLs wrap, and the list width is draggable (double-click the splitter to reset) and remembered.
- Right: Summary (overview, matched rules, timing, errors) / Request / Response; interactive PB field tree; JSON tree; raw/hex views; patched ↔ original toggle; copy/download the body.
- **Rules** drawer: grouped by type, add/delete/enable/disable rules, edit the mock data file for `map_local(data)`, save or reload `rules.yaml`.
- **Setup & CA**: proxy address, CA download, fingerprint, per-platform install steps, data directory and capture limits.
- Dark and light themes (`◐` toggles), live updates over SSE, automatic reconnect.

## Data and configuration

The default data directory is `~/.pbmockx` (override with `PBMOCKX_DATA_DIR`):

```
~/.pbmockx/
├─ config.json        # optional: port / upstream TLS / capture limits
├─ runtime.json       # pid/port of the running daemon
├─ rules.yaml         # all mock rules (loaded and saved automatically)
├─ mock-data/         # JSON files backing map_local(data)
├─ ca/                # ca.pem / ca.key / leaf.key
├─ desc-cache/        # conditional-request cache for .desc files
└─ logs/pbmockxd.log
```

Common environment variables: `PBMOCKX_PORT`, `PBMOCKX_HOST`, `PBMOCKX_DATA_DIR`, `PBMOCKX_LAN`,
`PBMOCKX_LOG_LEVEL`, `PBMOCKX_LANG`. The legacy `WHISTLE_PORT` is still honoured as a lowest-priority fallback.

Example config (`~/.pbmockx/config.json`):

```json
{
  "port": 8899,
  "host": "127.0.0.1",
  "lang": "zh",
  "ui": { "lanAccess": true },
  "proxy": {
    "mitm": true,
    "mitmPorts": [443, 8443],
    "bypass": ["*.apple.com"],
    "recordTunnels": true,
    "upstreamTLS": { "rejectUnauthorized": true }
  },
  "capture": {
    "maxFlows": 500,
    "maxRecordBodyBytes": 4194304,
    "maxTotalRecordBytes": 268435456,
    "maxRewriteBodyBytes": 67108864
  }
}
```

- When `map_remote` targets a loopback/private address, upstream certificate verification is skipped (for local HTTPS mock servers); other targets are verified by default.
- **Connections that were not decrypted still appear in the flow list**: a CONNECT that hits `bypass`, a port outside `mitmPorts`, `mitm=false`, or a TLS handshake failure (CA not trusted, certificate pinning, mTLS, non-TLS protocol) is recorded as a metadata-only tunnel flow — `method=CONNECT`, `url=tcp://host:port`, `tunnel=bypass|port|mitm-disabled|tls-handshake|ca-error`, bytes up/down and who closed it, **with no plaintext at all**. Set `"recordTunnels": false` to turn this off. That way “nothing shows up” can be narrowed down to a proxy that is not in effect, a rule that excluded the host, or a certificate problem.
- Only loopback is bound by default. With `--host 0.0.0.0` / `--lan`, the proxy, UI and control API are all reachable from the LAN; `ui.lanAccess=false` exposes only the proxy (the CA download endpoint stays available so devices can still install the certificate).

## Limitations

- HTTP/2 and gRPC are not supported yet: MITM only offers `http/1.1` via ALPN, and upstream connections are HTTP/1.1. For pure h2/gRPC endpoints use `proxy.bypass` so they go through as raw tunnels, or wait for a later release; such connections appear in the list as `tunnel=tls-handshake` or `tunnel=bypass` metadata records.
- mTLS traffic cannot be intercepted — bypass it.
- There is no breakpoint/intercept feature: use patch rules plus `rules reload` for live changes.
- WebSocket traffic is tunnelled and byte-counted only; frames are not parsed.
- Flows are kept in memory (LRU plus a total byte budget) and are cleared on restart.

## Development

```bash
npm install                 # if the sandbox restricts the npm cache: npm install --cache .npm-cache
npm run build               # tsc → dist/
npm run typecheck
npm test                    # node:test (core / CA / HTTP / HTTPS / PB / CLI)
node bin/pbmockx.js --data-dir .dev-data start --port 8899
```

Layout: `src/core` (PB engine, rules, flow store), `src/proxy` (proxy, CA), `src/mock` (rule
execution), `src/server` (daemon, control API, static UI), `src/cli`, `web/`. Development details
live in `AGENTS.md`.

## Migrating from whistle

| Old | New |
|---|---|
| `w2 start/stop/status` | `pbmockx start/stop/status` |
| `w2 ca` | `pbmockx ca` |
| `pbmockx` via `w2 exec` | `pbmockx` directly (after `npm link`) |
| `whistle-plugin/rules.yaml` | `~/.pbmockx/rules.yaml` (imported on first start) |
| whistle CA | pbmockx CA (must be trusted again) |
| `pipe://pbmockx` rules | not needed (all traffic goes through pbmockx by default) |

## License

MIT
