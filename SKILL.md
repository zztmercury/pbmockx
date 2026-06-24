---
name: mitmproxy-mock
description: Operate a mitmproxy capture session to view and mock protobuf (Charles self-describing Content-Type rule) and JSON responses. The addon auto-detects protocol and decodes to dict; AI agents patch fields by path. Trigger when user says "抓包","mock 数据","改接口返回","看 PB/JSON 响应","mitmproxy-mock","改 protobuf".
---

# mitmproxy-mock — Agent Guide

You operate a mitmproxy capture session via the `mitmproxy-mock` CLI. A mitmproxy
addon has **already auto-detected the protocol** (protobuf or JSON) of every
captured HTTP response and decoded it into a plain **dict/list** (JSON-like).

## Core abstraction (important)
- Protobuf (Charles self-describing rule: `Content-Type: application/x-protobuf;
  desc="<url>"; messageType="<FQN>"; delimited=true`) is decoded to dict via
  `json_format.MessageToDict` (proto field names preserved).
- JSON is decoded via `json.loads`.
- **You never touch protobuf wire format.** You only read/modify dict fields by
  `path` (dot + `[index]`), exactly like editing JSON. PB and JSON are identical
  at the operation layer.
- delimited protobuf lists decode to a JSON array of dicts.

## Commands
```
mitmproxy-mock flows                              # list captured flows + protocol tag
mitmproxy-mock decode <id>                        # full decoded dict (+protocol/messageType)
mitmproxy-mock mock <id> <path> <value>           # patch ONE flow's response field (single-shot)
mitmproxy-mock rules add <url_regex> <path> <value> [--protocol pb|json]  # continuous rule
mitmproxy-mock rules list
mitmproxy-mock rules del <index>
mitmproxy-mock intercept on [--filter <mitmproxy filter>]   # pause flows to edit before delivery
mitmproxy-mock intercept off
mitmproxy-mock resume <id>                        # release an intercepted flow to client
mitmproxy-mock replay <id>                        # replay a (possibly modified) flow
mitmproxy-mock health                             # check addon control API
mitmproxy-mock agent-doc                          # print this guide
```
- `<id>` is the flow id prefix shown by `flows` (first 8 chars accepted).
- `<path>` uses dot + index: `game.name`, `items[0].id`, `a.b[2].c`.
- `<value>` is parsed as JSON if possible (int/bool/null/object/array), else string.
  Quote strings in shell: `"hello"`; for objects: '{"k":"v"}'.

## Two mock modes
1. **Continuous rule** (`rules add`): every response whose URL matches
   `<url_regex>` gets the field patched on the fly — client receives modified
   data. Use this to build a stable mocked test environment.
2. **Single-shot** (`mock <id>`): patch one already-captured flow's response in
   store. To actually deliver the change to the client, either:
   - `intercept on` BEFORE the request → flow pauses → `mock` → `resume <id>`,
     or
   - `mock` then `replay <id>` to re-issue.

## Typical workflow
1. `mitmproxy-mock flows` — find the target flow, note id + protocol.
2. `mitmproxy-mock decode <id>` — inspect the decoded dict, identify the field path.
3. Either `rules add '~q /api/game' game.name "测试"` (continuous),
   or `intercept on` → trigger request → `mock <id> game.name "测试"` → `resume <id>`.
4. Verify on device / `replay <id>`.

## Notes
- If `decode` returns `error`: the response wasn't recognized as PB/JSON, or PB
  schema (desc URL) couldn't be loaded / messageType not found. Check the
  Content-Type header has valid `desc`/`messageType` params.
- Continuous rules apply at capture time; `decode` shows the (possibly mocked)
  decoded data.
- Control API default: http://127.0.0.1:9090 (override via
  MITMPROXY_MOCK_HOST / MITMPROXY_MOCK_PORT env).
