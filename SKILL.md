---
name: flowmock
description: Capture and mock protobuf (Charles self-describing rule) / JSON responses via mitmproxy. The addon auto-detects protocol and decodes to dict; AI patches fields by path. Charles-style map local/remote/breakpoint. Trigger when user says "抓包","mock 数据","改接口返回","看 PB/JSON 响应","flowmock","改 protobuf","改返回数据","造测试数据","map local","map remote","breakpoint".
---

# flowmock — Agent Guide

A mitmproxy addon auto-detects the protocol (protobuf or JSON) of every captured
HTTP response and decodes it into a plain **dict/list**. You operate it via the
`flowmock` CLI. **You never touch protobuf wire format** — you read/modify
dict fields by `path`, exactly like editing JSON. PB and JSON are identical at
the operation layer.

## 1. Prerequisites — check FIRST, every time

Run `flowmock doctor` before anything else. It checks the full chain:
Python / venv / CLI / skill / addon / traffic. Interpret the result:

| result | meaning | action |
|---|---|---|
| addon: NOT running | mitmproxy not running | Run `flowmock start` (background, non-blocking — starts mitmdump, waits for control API, returns). |
| addon: OK, traffic: NO traffic | addon up but no traffic | Proxy/cert not ready OR app idle. Ask user to operate the app (open a page / search) to trigger traffic, then re-check. If still 0 after app activity → cert not installed or device proxy not set (guide: device visits http://mitm.it to install CA; `adb reverse tcp:8080 tcp:8080` + `adb shell settings put global http_proxy 127.0.0.1:8080`). |
| addon: OK (flow_count=N>0) | ready | proceed to workflow |

Never assume mitmproxy is running — always verify with `doctor` first.

## 2. Standard workflow — follow this order

**Step 1 — Find the target flow:**
```
flowmock flows
```
Output: `<id>  METHOD STATUS [protocol] URL [paused] [ERR]`. Note the `id` (first 8 chars
accepted) and `protocol` (`protobuf`/`json`) of the flow you want to mock.
- Filter by eye: look for the URL path matching the feature you're testing.
- `[protobuf]` = PB interface (decoded via Charles desc rule); `[json]` = JSON.
- `[paused]` = flow is intercepted by a breakpoint rule — waiting for your action.
- `ERR:...` = that flow failed to decode — see Troubleshooting.
- Use `--filter <regex>` to narrow down: `flowmock flows --filter api/game`

**Step 2 — Inspect the decoded structure:**
```
flowmock decode <id>
```
Returns `{protocol, messageType, desc, content_type, data: {...}}`. Read `data`
to find the exact field `path` you want to change. PB `data` may contain
`@type` (a google.protobuf.Any expanded into a concrete message) — navigate into
it like normal nested dict.
- Use `--original` to see the raw response before any mock rules were applied:
  `flowmock decode <id> --original`

**Step 3 — Decide mock mode:**

Decision tree (by priority):

1. **Know which field to change?** → **Patch rule** (`rules add`) — RECOMMENDED.
   Auto-modifies matching responses, no pause, no timeout. Works for PB + JSON.
2. **Need to replace entire response body?** → **Map Local** (`map-local add`).
3. **Need to redirect request to another server?** → **Map Remote** (`map-remote add`).
4. **Need to dynamically decide what to change at runtime?** → **Breakpoint** (`breakpoint add`).
   ⚠️ Pauses flow — client waits. Agent async processing (LLM inference ~2s/step)
   may cause client timeout. Use as last resort.

### 2.1 Patch — modify specific fields by path (RECOMMENDED, no pause, no timeout)

**Standard workflow (preferred for Agent):**
```
# 1. Capture a real request first (or ask user to trigger once)
flowmock flows --filter 'api/game'     # find existing flow
flowmock decode <id>                    # inspect structure, get the path

# 2. Add persistent rule — auto-modifies all future matching responses
flowmock rules add 'api/game' game.name 'MockedGame'
flowmock rules add 'api/game' game.id 999

# 3. User re-triggers request → response auto-modified → client receives mocked data
#    No pause, no timeout ✅

# 4. Verify
flowmock flows --filter 'api/game'     # new flow captured
flowmock decode <new_id>               # game.name=MockedGame, game.id=999
```

- Works identically for **PB and JSON** — both decoded to dict, path-patched, re-encoded.
- `--protocol pb|json` optional filter (omit = apply to both).
- Rules auto-save to `rules.yaml` (persist across restarts).
- Single-shot `mock <id>` also available but does NOT reach client on completed flows
  (use `replay <id>` to re-deliver, or use patch rule instead).

### 2.2 Map Local — replace entire response body (Charles-style)
```
flowmock map-local add '<url_regex>' <file_path> [--status 200] [--header "K:V"]
flowmock map-local add '<url_regex>' --data '<json>' [--desc <url>] [--messageType <name>] [--delimited]
```
- **File mode** (Charles-compatible): local file's raw bytes become the response body.
- **Dict mode** (PB enhancement): provide a JSON dict, auto-encode to PB using
  the response's `desc`/`messageType` (auto-detected from flow_store, or
  specified via `--desc`/`--messageType`). This is the key advantage over Charles —
  you never write PB wire format.
- `--status` overrides HTTP status code. `--header "K:V"` adds/overrides headers.

### 2.3 Map Remote — redirect requests to another URL (Charles-style)
```
flowmock map-remote add '<url_regex>' <new_url>           # full URL replacement
flowmock map-remote add '<url_regex>' <replacement> --regex  # regex partial replacement
```
- Full URL mode: matching requests are redirected to `<new_url>` entirely.
- Regex mode: `re.sub(url_regex, replacement, url)` — flexible partial replacement.
- Useful for pointing test environment requests to a mock server.

### 2.4 Breakpoint — per-URL pause (last resort, ⚠️ may cause timeout)
```
flowmock breakpoint add '<url_regex>'
```
- **⚠️ Timeout risk**: breakpoint PAUSES the flow — client waits for response.
  Agent async processing (find flow → decode → mock → resume, each step ~2s LLM)
  may exceed client timeout. **Prefer patch rules (§2.1) unless you need
  runtime-decided values.**
- **Rule-based, persistent**: add once, all future matching flows auto-pause.
- Unlike `intercept on` (which blocks ALL requests globally), breakpoint rules
  only pause matching URLs — other traffic flows normally.
- **Verified end-to-end** (pause → mock → resume → client receives mocked response ✅).
- Full interaction flow:
  ```
  flowmock breakpoint add 'api/game'         # add rule (persistent)
  # ask user to trigger request in app
  flowmock flows --paused                    # find the paused flow
  flowmock decode <id>                       # inspect current data
  flowmock mock <id> game.name MockedGame     # modify field
  flowmock resume <id>                       # release → client gets mocked response
  # or: flowmock abort <id>                  # cancel → client gets error
  flowmock breakpoint off                    # clear all breakpoint rules when done
  ```
- `flowmock breakpoint off` clears all breakpoint rules.

**Step 4 — Execute:**
- **Patch rule (RECOMMENDED — no pause, no timeout):**
  ```
  flowmock rules add '<url_regex>' <path> <value> [--protocol pb|json]
  # user re-triggers → response auto-modified → client receives mocked data
  ```
- Patch single-shot via breakpoint (⚠️ may timeout, see §2.4):
  ```
  flowmock breakpoint add '<url_regex>'
  # ask user to trigger the request in app
  flowmock flows --paused   # find the paused flow
  flowmock mock <id> <path> <value>
  flowmock resume <id>
  flowmock breakpoint off   # clear when done
  ```
- Patch single-shot via intercept (⚠️ blocks ALL traffic globally):
  ```
  flowmock intercept on
  # ask user to trigger the request in app
  flowmock flows          # find the new (paused) flow id
  flowmock mock <id> <path> <value>
  flowmock resume <id>
  flowmock intercept off  # turn off when done
  ```
- Map Local: see §2.2
- Map Remote: see §2.3

**Step 5 — Verify:**
```
flowmock decode <id>              # shows the (mocked) decoded data
flowmock decode <id> --original   # shows original (pre-mock) for comparison
flowmock rules list               # confirm rules active
flowmock rules list --type map_local   # filter by type
```
Or ask user to check the app screen.

## 3. Commands reference

### Capture & mock
```
flowmock health                             # quick addon check (ok + flow_count)
flowmock doctor                             # full-chain health check
flowmock flows [--filter <regex>] [--paused]  # list flows + protocol + paused tag
flowmock flows clear                        # clear all captured flows
flowmock decode <id> [--original]           # full decoded dict + meta
flowmock mock <id> <path> <value>           # patch ONE flow (single-shot)
flowmock replay <id>                        # replay a flow
flowmock resume <id>                        # release intercepted/breakpointed flow
flowmock abort <id>                         # kill flow (send error to client)
flowmock intercept on [--filter <expr>]     # pause ALL matching flows (global)
flowmock intercept off
```

### Rules — patch type (persistent, by path)
```
flowmock rules add <url_regex> <path> <value> [--protocol pb|json]
flowmock rules list [--type <type>]
flowmock rules del <id>
flowmock rules save                         # manually write back to rules.yaml
flowmock rules reload                       # reload from rules.yaml
```

### Map Local (Charles-style body replacement)
```
flowmock map-local add <url_regex> <file_path> [--status N] [--header "K:V"]
flowmock map-local add <url_regex> --data '<json>' [--desc <url>] [--messageType <name>] [--delimited]
flowmock map-local list
flowmock map-local del <id>
```

### Map Remote (Charles-style request redirect)
```
flowmock map-remote add <url_regex> <new_url> [--regex]
flowmock map-remote list
flowmock map-remote del <id>
```

### Breakpoint (Charles-style per-URL pause)
```
flowmock breakpoint add <url_regex>
flowmock breakpoint list
flowmock breakpoint del <id>
flowmock breakpoint off                     # clear all breakpoints
```

### Tool maintenance
```
flowmock skill install [--agent opencode|claude|all] [--dir <path>]
flowmock skill list
flowmock skill uninstall [--agent <name>]
flowmock update [--check]
flowmock version
flowmock start / stop / restart             # start: background daemon, non-blocking
flowmock agent-doc                          # print this guide
```

## 4. Path & value syntax
- **path**: dot for nested field, `[n]` for list index.
  `game.name` · `items[0].id` · `data.list[0].list[0].brand.app.title`
- **value**: parsed as JSON if possible — `int` (`100`), `bool` (`true`/`false`),
  `null`, object (`{"k":"v"}`), array (`[1,2]`). Otherwise treated as string.
  In shell, quote strings: `"hello"`. For objects/arrays use single quotes
  around the JSON: `'{"k":"v"}'`.
- Paths are **case-sensitive** — proto field names are snake_case (not camelCase).

## 5. Troubleshooting
- **`decode` returns `error: "Couldn't find message X"`**: the .desc loaded but
  message X's file failed to add (missing google well-known dep) — this is an
  addon bug, report it. Or `desc` URL unreachable / `messageType` wrong: check
  the `content_type` and `desc` fields in the decode output.
- **`decode` returns `error` other**: response not recognized as PB/JSON, or
  body malformed. Check `content_type` — must be `application/x-protobuf` (PB)
  or contain `json` (JSON).
- **mock didn't reach the client**: single-shot `mock` only updates the stored
  flow. Use `intercept on`→`mock`→`resume`, or `mock`+`replay`. Continuous rules
  apply only to NEW matching responses (after the rule is added).
- **`flow_count` stays 0**: see Prerequisites — cert/proxy/app-idle.
- **field path wrong / IndexError**: re-run `decode <id>` and copy the exact path
  from the dict structure. Paths are case-sensitive.
- **mock returns 400 "path not found"**: the path doesn't exist in the decoded
  data. The response includes a `hint` showing the actual data structure —
  copy the correct path from it.
- **map-local dict mode fails**: needs `desc` + `messageType` to encode PB.
  Auto-detected from flow_store if the URL was captured before. If not, provide
  `--desc <url>` and `--messageType <name>` explicitly.
- **breakpoint blocks forever**: breakpoint rules are persistent — they pause
  ALL future matching flows. Use `flowmock breakpoint off` to clear when done.
- **rules not persisted**: `rules add` auto-saves to rules.yaml. If save fails
  (permission/disk), run `flowmock rules save` manually. Check with `flowmock rules list`.

## 6. Notes
- Control API default: http://127.0.0.1:9090 (override via
  `FLOWMOCK_HOST` / `FLOWMOCK_PORT` env).
- Continuous rules apply at capture time; `decode` shows the (possibly mocked)
  decoded data. Use `--original` to see pre-mock data.
- PB `delimited=true` responses decode to a JSON array; index into them with `[n]`.
- flow_store has LRU cap (500 flows); oldest evicted when full.
- All rule types (patch/map_local/map_remote/breakpoint) share the same rules.yaml
  and can coexist. Execution order per request:
  map_remote(request) → map_local(response) → breakpoint(response) → patch(response).
