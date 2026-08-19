#!/usr/bin/env node
/**
 * pbmockx CLI — whistle.pbmockx plugin command-line interface.
 *
 * Usage:
 *   w2 exec pbmockx <command> [args]    (native whistle way)
 *   pbmockx <command> [args]            (after npm link / install.sh)
 */

'use strict';

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WHISTLE_PORT = process.env.WHISTLE_PORT || 8899;
const PLUGIN_BASE = '/plugin.pbmockx';
const HOST = '127.0.0.1';

// --- HTTP helper ---

function _req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullPath = PLUGIN_BASE + urlPath;
    const headers = {};
    let data = null;
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ hostname: HOST, port: WHISTLE_PORT, path: fullPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          try { reject(new Error(JSON.parse(raw).error || raw)); }
          catch { reject(new Error('HTTP ' + res.statusCode + ': ' + raw.slice(0, 200))); }
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function _parseValue(s) {
  try { return JSON.parse(s); }
  catch { return s; }
}

// --- Android cert detection (node-forge) ---

let _forge;
function forge() { if (!_forge) _forge = require('node-forge'); return _forge; }

/** Compute OpenSSL subject_hash_old (Android CA filename hash) from PEM. */
function subjectHashOld(pem) {
  const f = forge();
  const cert = f.pki.certificateFromPem(pem);
  const derBytes = f.asn1.toDer(f.pki.distinguishedNameToAsn1(cert.subject)).getBytes();
  return crypto.createHash('md5').update(Buffer.from(derBytes, 'binary')).digest().readUInt32LE(0).toString(16).padStart(8, '0');
}

/** Fetch whistle rootCA PEM from main whistle port (not plugin base). */
function fetchRootCa() {
  return new Promise((resolve, reject) => {
    const r = http.get({ hostname: HOST, port: WHISTLE_PORT, path: '/cgi-bin/rootca' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout fetching rootca')));
  });
}

/** adb shell; returns {ok, out, denied, missing, err}. denied != not-installed. */
function adbShell(serial, cmd) {
  const full = (serial ? 'adb -s ' + serial + ' shell ' : 'adb shell ') + cmd;
  try { return { ok: true, out: execSync(full, { stdio: 'pipe' }).toString().trim() }; }
  catch (e) {
    // adb 会把设备端的 stdout/stderr 合并转发到本地 stdout，所以命令
    // 失败信息（如 "No such file" / "Permission denied"）通常在 e.stdout
    // 而非 e.stderr —— 两者都查，否则 missing/denied 分类会失效。
    const msg = String(
      (e.stdout && e.stdout.toString().trim()) ||
      (e.stderr && e.stderr.toString().trim()) ||
      e.message || ''
    );
    if (/No such file|does not exist/i.test(msg)) return { ok: true, out: '', missing: true };
    if (/Permission denied|not permitted|opendir failed/i.test(msg)) return { ok: true, out: '', denied: true };
    return { ok: false, err: msg };
  }
}

/** Whether adbd is already running as root (e.g. `adb root` on userdebug/eng builds). */
function isAdbRoot(serial) {
  const r = adbShell(serial, 'id');
  return r.ok && /uid=0/.test(r.out);
}

/** Whether the device has a working su binary (root, e.g. Magisk/SuperSU). */
function hasSu(serial) {
  // `adb shell "su -c id"`：root 设备输出 `uid=0(root) ...`；无 su 二进制报
  // "not found"（→ ok:false）；su 存在但拒绝授权输出 "Permission denied"。
  const r = adbShell(serial, '"su -c id"');
  return r.ok && /uid=0/.test(r.out);
}

/** Detect cert by subject hash on device. state: system|user|not_found|unknown. */
function detectCert(serial, hash) {
  // 系统证书目录（world-readable，shell 可直接读）：Android ≤9 用 /system，
  // 10+ 用 Conscrypt APEX，Android 14/15 必须查 APEX 路径。
  const sysDirs = ['/apex/com.android.conscrypt/cacerts', '/system/etc/security/cacerts'];
  // 用户证书目录（user 0 = 主用户），13→15 从未迁移。
  // 注意：该目录受 SELinux 保护（标签 misc_user_data_file，shell 域无访问权），
  // 非 root 设备 `ls` 必然 Permission denied —— 只能以 root 探测。
  const usrDir = '/data/misc/user/0/cacerts-added';

  // 证书命名 <hash>.<index>（同 subject 多证书时序号递增 .0/.1/.2）。
  // mode: 'direct'（当前 shell 已是 root，直接 ls）| 'su'（su -c ls）
  const probe = (dir, mode) => {
    let found = false;
    let denied = false;
    let ok = true;
    for (const idx of [0, 1, 2]) {
      const target = dir + '/' + hash + '.' + idx;
      // 系统证书目录直接 ls；用户证书目录需 root（adbd root 直接 ls，否则 su -c）
      const cmd = mode === 'su'
        ? '"su -c \'ls ' + target + '\'"'
        : 'ls ' + target;
      const r = adbShell(serial, cmd);
      if (r.ok && r.out) { found = true; break; }
      if (r.denied) denied = true;
      if (!r.ok) ok = false; // 其他错误（如设备离线）→ 无法判定
    }
    return { dir, found, denied, ok };
  };

  const system = sysDirs.map(d => probe(d, 'direct'));

  // 用户证书：非 root 设备无法探测（SELinux 阻止），标记 denied → unknown。
  // root 来源二选一：adbd 已 root（`adb root`）→ 直接 ls；否则 su 可用 → su -c。
  const adbRoot = isAdbRoot(serial);
  const suRoot = !adbRoot && hasSu(serial);
  const root = adbRoot || suRoot;
  const user = root
    ? [probe(usrDir, adbRoot ? 'direct' : 'su')]
    : [{ dir: usrDir, found: false, denied: true, ok: true }];

  return { state: classifyCertState(system, user), system, user, root };
}

/** Classify cert state from probe results. Pure function. */
function classifyCertState(system, user) {
  const systemFound = system.some(d => d.found);
  const userFound = user.some(d => d.found);
  // 任一目录 denied 或探测失败（!ok）都算「无法判定」——不能因为系统证书
  // 没找到就下 "not_found" 结论，否则用户证书目录读不到（denied）时会把
  // 「可能已装但读不到」误报成「未安装」。
  const anyIndeterminate = system.concat(user).some(d => d.denied || !d.ok);
  if (systemFound) return 'system';
  if (userFound) return 'user';
  if (anyIndeterminate) return 'unknown';
  return 'not_found';
}

/** Classify proxy state from raw adb output. Pure function. */
function classifyProxyState(raw, expected) {
  const v = (raw || '').trim();
  if (!v || v === 'null' || v === ':0') return { state: 'unset', raw: v, expected };
  return { state: v === expected ? 'ok' : 'mismatch', raw: v, expected };
}

/** Detect proxy state: ok|unset|mismatch|unknown. */
function detectProxy(serial) {
  const expected = '127.0.0.1:' + WHISTLE_PORT;
  const r = adbShell(serial, 'settings get global http_proxy');
  if (!r.ok) return { state: 'unknown', raw: r.err, expected };
  return classifyProxyState(r.out, expected);
}

/** Parse `adb devices` output → array of {serial,state} (all states, incl offline/unauthorized). Pure function. */
function parseDevices(out) {
  return (out || '').split('\n').slice(1).map(l => l.trim()).filter(Boolean)
    .map(l => { const p = l.split(/\s+/); return { serial: p[0], state: p[1] || '' }; });
}

/** List authorized adb devices. Returns null if adb unavailable. */
function listDevices() {
  try { return parseDevices(execSync('adb devices', { stdio: 'pipe' }).toString()); }
  catch (e) { return null; }
}

// --- Help text ---

function helpMain() {
  console.log(`Usage: pbmockx <command> [args] [options]

Commands:
  flows [--filter <regex>]        List decoded flows
  decode <id> [--req|--res] [--original]  Show flow details (headers + body)
  rules add <url> <path> <value> [--protocol pb|json]  Add patch rule
  rules list [--type <type>]      List rules
  rules del <id>                  Delete rule
  rules save                      Save rules.yaml
  rules reload                    Reload rules.yaml
  map-local add <url> --data <json>|--file <path>  Add map_local rule
  map-local list                  List map_local rules
  map-local del <id>              Delete map_local rule
  map-remote add <url> <replacement> [--regex]  Add map_remote rule
  map-remote list                 List map_remote rules
  map-remote del <id>             Delete map_remote rule
  web                             Open whistle Web UI
  connect-android [-s <serial>]   Configure Android proxy + detect cert status
  doctor                          Check w2 + plugin + rules health
  fix                             Auto-repair plugin (re-link + restart)
  agent-doc                       Print SKILL.md
  skill install                   Install SKILL.md to agent dirs
  version [--check]               Show version

Process management (w2 native):
  w2 start / w2 stop / w2 restart / w2 status / w2 ca

Options:
  -h, --help                      Show this help (use with subcommand for subcommand help)
  --protocol <pb|json>            Specify protocol for patch rule
  --original                      Show original (pre-patch) data

Run 'pbmockx <command> --help' for command-specific help.`);
}

function helpFlows() {
  console.log(`Usage: pbmockx flows [--filter <regex>]

List decoded flows (from pipe resRead/reqRead).

Options:
  --filter <regex>                Filter flows by URL regex
  -h, --help                      Show this help

Examples:
  pbmockx flows
  pbmockx flows --filter api.xdrnd`);
}

function helpDecode() {
  console.log(`Usage: pbmockx decode <id> [--req|--res] [--original] [--path <path>] [--full]

Show flow details: headers + decoded body (PB field tree or JSON).

Arguments:
  id                              Flow ID (from 'pbmockx flows')

Options:
  --req                           Show only request headers + body
  --res                           Show only response headers + body
  --original                      Show original (pre-patch) data instead of patched
  --path <path>                   Navigate to subtree (e.g. data.list[0].list[2].app)
  --full                          Expand all fields (default: collapsed top-level only)
  -h, --help                      Show this help

Default output is collapsed — nested messages show (type, N fields) ▸.
Use --path to drill into a subtree, or --full to expand everything.

Examples:
  pbmockx decode abc123
  pbmockx decode abc123 --res
  pbmockx decode abc123 --path data.list[0].list[2].app
  pbmockx decode abc123 --full
  pbmockx decode abc123 --original`);
}

function helpRules() {
  console.log(`Usage: pbmockx rules <subcommand> [args]

Subcommands:
  add <url> <path> <value> [--protocol pb|json]   Add patch rule (replace field)
  add <url> <path> --append <value>               Append item to a repeated field
  add <url> <path> --insert <idx> <value>         Insert item at index of a repeated field
  add <url> <path> --remove <idx>                 Remove item at index of a repeated field
  list [--type patch|map_local|map_remote]        List rules
  del <id>                                        Delete rule by ID
  save                                            Save rules to rules.yaml
  reload                                          Reload rules from rules.yaml

Options:
  -h, --help                      Show this help

Examples:
  pbmockx rules add 'api/game' game.name TestName --protocol pb
  pbmockx rules add 'api/game' game.tags --append '{"k":"v"}'
  pbmockx rules add 'api/game' game.list --insert 1 '{"id":9}'
  pbmockx rules add 'api/game' game.list --remove 0
  pbmockx rules list
  pbmockx rules del abc12345`);
}

function helpMapLocal() {
  console.log(`Usage: pbmockx map-local <subcommand> [args]

Subcommands:
  add <url> --data '<json>' [--desc <url>] [--messageType <type>] [--delimited]
  add <url> --file <path>
  list
  del <id>

Options:
  --data <json>                   Inline mock data (JSON)
  --file <path>                   Path to mock file (PB binary or JSON)
  --desc <url>                    .desc URL for PB encoding
  --messageType <type>            PB message type
  --delimited                     Use length-delimited framing
  --status <code>                Override HTTP status code
  -h, --help                      Show this help`);
}

function helpMapRemote() {
  console.log(`Usage: pbmockx map-remote <subcommand> [args]

Subcommands:
  add <url> <replacement> [--regex]
  list
  del <id>

Options:
  --regex                         Use regex substitution (partial replace)
  -h, --help                      Show this help`);
}

function helpWeb() { console.log(`Usage: pbmockx web\n\nOpen whistle Web UI in browser.`); }
function helpConnectAndroid() { console.log(`Usage: pbmockx connect-android [-s <serial>]\n\nConfigure Android device proxy and detect whistle rootCA install\nstatus (system / user / not_found / unknown).\n\nStep 1 configures proxy (executed). Step 2 detects cert install status\n(read-only checks) — does NOT install or modify certs.\n\nNote: the user-cert directory is protected by SELinux — on non-root\ndevices it cannot be read, so status is 'unknown' unless the cert is\nfound as a system cert. Verify manually in Settings > Security.`); }
function helpDoctor() { console.log(`Usage: pbmockx doctor\n\nCheck w2 + plugin + rules health.\n\nIf plugin is not reachable, run 'pbmockx fix' to auto-repair.`); }
function helpFix() { console.log(`Usage: pbmockx fix\n\nAuto-repair plugin installation:\n  1. Rebuild (npm install + tsc) if needed\n  2. Re-link (npm link) if unlinked\n  3. Restart whistle to reload plugin + rules.txt\n\nUse when plugin was uninstalled from Web UI or npm link broke.`); }
function helpAgentDoc() { console.log(`Usage: pbmockx agent-doc\n\nPrint SKILL.md content.`); }
function helpSkill() { console.log(`Usage: pbmockx skill <install|list|uninstall>\n\nManage SKILL.md in agent directories (~/.agents/skills/ and ~/.claude/skills/).`); }
function helpVersion() { console.log(`Usage: pbmockx version [--check]\n\nShow version (optionally check GitHub for updates).`); }

function hasHelp(args) { return args.includes('-h') || args.includes('--help'); }

// --- Output helpers ---

function printTable(rows, headers) {
  if (!rows || rows.length === 0) { console.log('(none)'); return; }
  const keys = headers || Object.keys(rows[0]);
  const widths = keys.map(k => Math.max(k.length, ...rows.map(r => String(r[k] != null ? r[k] : '').length)));
  console.log(keys.map((k, i) => k.padEnd(widths[i])).join('  '));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(keys.map((k, i) => String(r[k] != null ? r[k] : '').padEnd(widths[i])).join('  '));
  }
}

function formatHeaders(headers, prefix) {
  if (!headers) return prefix + '(no headers)';
  return Object.entries(headers).map(([k, v]) => prefix + k + ': ' + v).join('\n');
}

// --- Version & docs ---

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(PLUGIN_ROOT, '..');

function readVersion() {
  try { return fs.readFileSync(path.join(PROJECT_ROOT, 'VERSION'), 'utf-8').trim(); }
  catch { return 'unknown'; }
}

function readSkillDoc() {
  const skillPath = path.join(PROJECT_ROOT, 'skill', 'SKILL.md');
  const content = fs.readFileSync(skillPath, 'utf-8');
  return content.replace(/^---[\s\S]*?---\n/, '');
}

// --- Commands ---

async function cmd_flows(args) {
  if (hasHelp(args)) { helpFlows(); return; }
  const filterIdx = args.indexOf('--filter');
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;
  const qs = filter ? '?filter=' + encodeURIComponent(filter) : '';
  const data = await _req('GET', '/cgi-bin/flows' + qs);
  printTable(data.map(r => ({
    id: r.id,
    method: r.method,
    status: r.status || '',
    proto: [r.reqProto, r.resProto].filter(Boolean).join('/'),
    url: (r.url || '').slice(0, 70),
  })));
}

async function cmd_decode(args) {
  if (hasHelp(args) || args.length === 0) { helpDecode(); return; }
  const id = args.find(a => !a.startsWith('-'));
  if (!id) { helpDecode(); process.exit(1); }

  const wantReq = args.includes('--req');
  const wantRes = args.includes('--res');
  const original = args.includes('--original');
  const fullExpand = args.includes('--full');
  const pathIdx = args.indexOf('--path');
  const path = pathIdx >= 0 ? args[pathIdx + 1] : undefined;
  const qs = original ? '?original=1' : '';
  const data = await _req('GET', '/cgi-bin/flows/' + id + qs);

  if (data.error && !data.reqData && !data.resData) { console.error('Error:', data.error); process.exit(1); }

  const showReq = wantReq || (!wantRes && data.hasReq);
  const showRes = wantRes || (!wantReq && data.hasRes);

  if (showReq && (data.reqHeaders || data.reqData !== undefined)) {
    printSection('Request', data.method, data.url, data.reqHeaders, data.reqProtocol, data.reqMessageType, data.reqData, original, path, fullExpand);
    if (showRes) console.log('');
  }
  if (showRes && (data.resHeaders || data.resData !== undefined)) {
    printSection('Response', 'HTTP ' + (data.status || 200), data.url, data.resHeaders, data.resProtocol, data.resMessageType, data.resData, original, path, fullExpand);
  }
  if (data.error) console.error('Error:', data.error);
}

function printSection(title, methodLine, url, headers, protocol, messageType, body, original, path, fullExpand) {
  console.log('=== ' + title + ' ===');
  console.log(methodLine + ' ' + (url || ''));
  if (headers) {
    for (const [k, v] of Object.entries(headers)) console.log(k + ': ' + v);
  }
  console.log('');
  if (body) {
    let label;
    if (protocol === 'json') label = title + ' Body (JSON)';
    else if (protocol === 'form') label = title + ' Body (Form)';
    else label = title + ' Body (PB: ' + (messageType || '?') + ')';
    console.log('=== ' + label + (original ? ' [original]' : '') + ' ===');
    if (protocol === 'json') {
      console.log(JSON.stringify(body, null, 2));
    } else if (protocol === 'form') {
      const entries = Object.entries(body);
      if (!entries.length) {
        console.log('(empty)');
      } else {
        const maxKey = Math.max(...entries.map(e => e[0].length));
        for (const [k, v] of entries) {
          console.log(k + ' '.repeat(Math.max(2, maxKey - k.length + 2)) + '= ' + (Array.isArray(v) ? v.join(', ') : String(v)));
        }
      }
    } else if (body && body.fields) {
      try {
        if (fullExpand) {
          const { renderTree } = require('../dist/src/field-tree');
          console.log(renderTree(body));
        } else if (path) {
          const { navigatePath, renderTreeCollapsed } = require('../dist/src/field-tree');
          const subtree = navigatePath(body, path);
          if (subtree) {
            console.log(renderTreeCollapsed(subtree));
          } else {
            console.log('Path not found: ' + path);
            console.log('Available top-level fields: ' + body.fields.map(f => f.name).join(', '));
          }
        } else {
          const { renderTreeCollapsed } = require('../dist/src/field-tree');
          console.log(renderTreeCollapsed(body));
        }
      } catch (e) { console.log(JSON.stringify(body, null, 2)); }
    }
  }
}

async function cmd_rules(args) {
  const sub = args[0];
  if (hasHelp(args) || !sub) { helpRules(); return; }
  if (sub === 'add') {
    const url = args.find(a => !a.startsWith('-') && a !== 'add');
    const rulePath = args.find((a, i) => i > 0 && !a.startsWith('-') && a !== url);
    const protoIdx = args.indexOf('--protocol');
    const protocol = protoIdx >= 0 ? (args[protoIdx + 1] === 'pb' ? 'protobuf' : args[protoIdx + 1]) : undefined;
    const appendIdx = args.indexOf('--append');
    const insertIdx = args.indexOf('--insert');
    const removeIdx = args.indexOf('--remove');

    // action dispatch: exactly one of --append/--insert/--remove, else plain set
    const actions = [appendIdx, insertIdx, removeIdx].filter(i => i >= 0);
    if (actions.length > 1) {
      console.error('Error: --append/--insert/--remove are mutually exclusive');
      process.exit(1);
    }

    const rule = { type: 'patch', url_pattern: url, path: rulePath };
    if (protocol) rule.protocol = protocol;

    if (appendIdx >= 0) {
      if (!url || !rulePath) { console.error('Usage: pbmockx rules add <url> <path> --append <value>'); process.exit(1); }
      const value = args.find((a, i) => i > appendIdx && !a.startsWith('-'));
      if (value === undefined) { console.error('Error: --append requires a <value>'); process.exit(1); }
      rule.action = 'append';
      rule.value = _parseValue(value);
    } else if (insertIdx >= 0) {
      if (!url || !rulePath) { console.error('Usage: pbmockx rules add <url> <path> --insert <idx> <value>'); process.exit(1); }
      const idxRaw = args[insertIdx + 1];
      const value = args.find((a, i) => i > insertIdx + 1 && !a.startsWith('-'));
      if (!idxRaw || /^-/.test(idxRaw) || value === undefined) {
        console.error('Usage: pbmockx rules add <url> <path> --insert <idx> <value>'); process.exit(1);
      }
      rule.action = 'insert';
      rule.index = parseInt(idxRaw, 10);
      rule.value = _parseValue(value);
    } else if (removeIdx >= 0) {
      if (!url || !rulePath) { console.error('Usage: pbmockx rules add <url> <path> --remove <idx>'); process.exit(1); }
      const idxRaw = args[removeIdx + 1];
      if (!idxRaw || /^-/.test(idxRaw)) { console.error('Usage: pbmockx rules add <url> <path> --remove <idx>'); process.exit(1); }
      rule.action = 'remove';
      rule.index = parseInt(idxRaw, 10);
    } else {
      // plain set (backward compatible): value is the 3rd positional arg
      const value = args.find((a, i) => i > args.indexOf(rulePath) && !a.startsWith('-'));
      if (!url || !rulePath) { console.error('Usage: pbmockx rules add <url> <path> <value> [--protocol pb|json]'); process.exit(1); }
      rule.value = _parseValue(value);
    }

    const result = await _req('POST', '/cgi-bin/rules', rule);
    console.log('Rule added:', result.rule.id, result.rule.url_pattern, result.rule.path, '=>', result.rule.value);
  } else if (sub === 'list') {
    const typeIdx = args.indexOf('--type');
    const type = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
    const qs = type ? '?type=' + type : '';
    const data = await _req('GET', '/cgi-bin/rules' + qs);
    printTable(data.map(r => {
      let pathCol = r.path || r.replacement || r.file_path || '';
      if (r.type === 'patch' && r.action && r.action !== 'set') {
        pathCol += ' [' + r.action + (r.index !== undefined ? ' ' + r.index : '') + ']';
      }
      return { id: r.id, type: r.type, url: (r.url_pattern || '').slice(0, 50), path: pathCol, value: r.value !== undefined ? JSON.stringify(r.value) : '' };
    }));
  } else if (sub === 'del') {
    const id = args.find(a => !a.startsWith('-') && a !== 'del');
    if (!id) { console.error('Usage: pbmockx rules del <id>'); process.exit(1); }
    const result = await _req('DELETE', '/cgi-bin/rules/' + id);
    console.log('Deleted:', result.ok);
  } else if (sub === 'save') {
    const result = await _req('POST', '/cgi-bin/rules/save', {});
    console.log('Saved:', result.ok);
  } else if (sub === 'reload') {
    const result = await _req('POST', '/cgi-bin/rules/reload', {});
    console.log('Reloaded:', result.reloaded, 'rules');
  } else {
    helpRules();
  }
}

async function cmd_map_local(args) {
  const sub = args[0];
  if (hasHelp(args) || !sub) { helpMapLocal(); return; }
  if (sub === 'add') {
    const url = args.find(a => !a.startsWith('-') && a !== 'add');
    if (!url) { console.error('Usage: pbmockx map-local add <url> --data <json> [--desc <url>] [--messageType <type>]'); process.exit(1); }
    const dataIdx = args.indexOf('--data');
    const fileIdx = args.indexOf('--file');
    const descIdx = args.indexOf('--desc');
    const mtIdx = args.indexOf('--messageType');
    const delimIdx = args.includes('--delimited');
    const statusIdx = args.indexOf('--status');
    const rule = { type: 'map_local', url_pattern: url };
    if (dataIdx >= 0) { rule.data = JSON.parse(args[dataIdx + 1]); rule.source = 'data'; }
    else if (fileIdx >= 0) { rule.file_path = args[fileIdx + 1]; rule.source = 'file'; }
    else { console.error('Either --data or --file required'); process.exit(1); }
    if (descIdx >= 0) rule.desc = args[descIdx + 1];
    if (mtIdx >= 0) rule.messageType = args[mtIdx + 1];
    if (delimIdx) rule.delimited = true;
    if (statusIdx >= 0) rule.status = parseInt(args[statusIdx + 1], 10);
    const result = await _req('POST', '/cgi-bin/map-local', rule);
    console.log('Map local added:', result.rule.id, result.rule.url_pattern);
  } else if (sub === 'list') {
    const data = await _req('GET', '/cgi-bin/rules?type=map_local');
    printTable(data.map(r => ({ id: r.id, url: (r.url_pattern || '').slice(0, 50), source: r.source || '', file: (r.file_path || r.data_file || '').slice(0, 40) })));
  } else if (sub === 'del') {
    const id = args.find(a => !a.startsWith('-') && a !== 'del');
    const result = await _req('DELETE', '/cgi-bin/rules/' + id);
    console.log('Deleted:', result.ok);
  } else {
    helpMapLocal();
  }
}

async function cmd_map_remote(args) {
  const sub = args[0];
  if (hasHelp(args) || !sub) { helpMapRemote(); return; }
  if (sub === 'add') {
    const url = args.find(a => !a.startsWith('-') && a !== 'add');
    const replacement = args.find((a, i) => i > args.indexOf(url) && !a.startsWith('-'));
    if (!url || !replacement) { console.error('Usage: pbmockx map-remote add <url> <replacement> [--regex]'); process.exit(1); }
    const rule = { type: 'map_remote', url_pattern: url, replacement, is_regex: args.includes('--regex') };
    const result = await _req('POST', '/cgi-bin/rules', rule);
    console.log('Map remote added:', result.rule.id, result.rule.url_pattern, '=>', result.rule.replacement);
  } else if (sub === 'list') {
    const data = await _req('GET', '/cgi-bin/rules?type=map_remote');
    printTable(data.map(r => ({ id: r.id, url: (r.url_pattern || '').slice(0, 50), replacement: (r.replacement || '').slice(0, 50), regex: r.is_regex ? 'Y' : '' })));
  } else if (sub === 'del') {
    const id = args.find(a => !a.startsWith('-') && a !== 'del');
    const result = await _req('DELETE', '/cgi-bin/rules/' + id);
    console.log('Deleted:', result.ok);
  } else {
    helpMapRemote();
  }
}

function cmd_web(args) {
  if (hasHelp(args)) { helpWeb(); return; }
  const url = 'http://127.0.0.1:' + WHISTLE_PORT;
  console.log('Opening', url);
  try { execSync('open "' + url + '"'); } catch {
    try { execSync('xdg-open "' + url + '"'); } catch { console.log('Visit: ' + url); }
  }
}

async function cmd_connect_android(args) {
  if (hasHelp(args)) { helpConnectAndroid(); return; }
  const serialIdx = args.indexOf('-s');
  const serial = serialIdx >= 0 ? args[serialIdx + 1] : null;
  const port = WHISTLE_PORT;

  // Pre-flight device check: abort early if adb unusable or multiple devices without -s
  if (!serial) {
    const devices = listDevices();
    if (devices === null) {
      console.error('Error: adb not available. Install platform-tools and ensure adb is in PATH.');
      process.exit(1);
    }
    if (devices.length === 0) {
      console.error('Error: no adb device connected. Connect a device with USB debugging on.');
      process.exit(1);
    }
    if (devices.length > 1) {
      console.error('Error: ' + devices.length + ' adb devices connected — specify one with -s <serial>.');
      console.error('Available devices:');
      for (const d of devices) console.error('  ' + d.serial + ' (' + d.state + ')');
      process.exit(1);
    }
    // single device but not ready (offline/unauthorized)
    if (devices[0].state !== 'device') {
      console.error('Error: device ' + devices[0].serial + ' is ' + devices[0].state + ' (not ready).');
      console.error('Authorize the RSA fingerprint on the device, or reconnect and retry.');
      process.exit(1);
    }
  }

  function adbExec(cmd) {
    const full = (serial ? 'adb -s ' + serial + ' ' : 'adb ') + cmd;
    console.log('[exec] ' + full);
    try { execSync(full, { stdio: 'pipe' }); return true; }
    catch (e) { console.error('  failed: ' + String(e.message).split('\n')[0]); return false; }
  }

  // Step 1: configure proxy (executed by this command)
  console.log('=== Step 1: Configure proxy (executed) ===');
  adbExec('reverse tcp:' + port + ' tcp:' + port);
  adbExec('shell settings put global http_proxy 127.0.0.1:' + port);

  // Step 2: detect status (read-only checks — does NOT install/modify certs)
  console.log('\n=== Step 2: Detect status (read-only) ===');

  const proxy = detectProxy(serial);
  console.log('Proxy: ' + proxy.state + (proxy.raw ? ' [' + proxy.raw + ']' : '') + (proxy.state === 'mismatch' ? ' (expected ' + proxy.expected + ')' : ''));

  let certState = 'unknown';
  let cert = null;
  try {
    const pem = await fetchRootCa();
    const hash = subjectHashOld(pem);
    console.log('RootCA hash: ' + hash);
    cert = detectCert(serial, hash);
    certState = cert.state;
    const sysHit = cert.system.find(d => d.found);
    const usrHit = cert.user.find(d => d.found);
    const sysDenied = cert.system.some(d => d.denied);
    console.log('Cert (system): ' + (sysHit ? 'found @ ' + sysHit.dir : (sysDenied ? 'cannot check (permission denied)' : 'not found')));
    // 用户证书：非 root 设备无法读（SELinux 阻止），如实说明；root 设备已实际探测。
    console.log('Cert (user):   ' + (usrHit ? 'found @ ' + usrHit.dir : (cert.root ? 'not found' : 'requires root (su) to check')));
    console.log('Cert status:   ' + certState);
  } catch (e) {
    console.log('Cert status:   unknown (rootCA fetch/compute failed: ' + e.message + ')');
  }

  if (certState === 'user') {
    console.log('\n  WARNING: installed as USER certificate.');
    console.log('  Android 7+ apps (targetSdk>=24) do NOT trust user certs by default.');
    console.log('  HTTPS capture may fail unless the app trusts user certs');
    console.log('  (networkSecurityConfig) or the cert is installed as a SYSTEM');
    console.log('  cert (root / emulator / Magisk module).');
  } else if (certState === 'not_found') {
    console.log('\n  Manual steps to install (NOT executed by this command):');
    console.log('  1. Download: http://127.0.0.1:' + port + '/cgi-bin/rootca');
    console.log('  2. adb push rootCA.crt /sdcard/');
    console.log('  3. Settings > Security > Install from storage');
    console.log('  Re-run: pbmockx connect-android' + (serial ? ' -s ' + serial : '') + '  (after install, to verify)');
  } else if (certState === 'unknown') {
    // 非 root 设备：系统证书未装、用户证书目录受 SELinux 保护读不到，无法自动确认。
    // 引导用户到设置手动核对，而非误导为「已装/未装」。
    console.log('\n  Cannot automatically confirm cert status:');
    if (!cert || !cert.root) {
      console.log('  - System cert: not installed');
      console.log('  - User cert:   cannot check without root (su) — the user-cert');
      console.log('    directory is protected by SELinux on non-root devices.');
    } else {
      console.log('  (permission denied or device offline)');
    }
    console.log('  Verify manually: Settings > Security > Encryption & credentials >');
    console.log('    Trusted credentials > User tab (look for the whistle/pbmockx CA).');
    console.log('  Note: a USER cert is NOT trusted by apps targeting Android 7+ unless');
    console.log('  the app uses networkSecurityConfig. For reliable HTTPS capture, install');
    console.log('  as a SYSTEM cert (root / Magisk) or use an emulator.');
  } else if (certState === 'system') {
    console.log('\n  Cert installed as SYSTEM certificate — apps should trust it.');
  }
}

async function cmd_doctor(args) {
  if (hasHelp(args)) { helpDoctor(); return; }
  console.log('=== pbmockx doctor ===');
  console.log('Node:', process.version);
  try {
    const w2ver = execSync('w2 --version', { stdio: 'pipe' }).toString().trim();
    console.log('whistle:', w2ver);
  } catch { console.log('whistle: NOT FOUND (install: npm i -g whistle)'); }
  let pluginOk = false;
  try {
    const health = await _req('GET', '/cgi-bin/health');
    pluginOk = health.ok;
    console.log('Plugin:', health.ok ? 'OK' : 'FAIL', '| flows:', health.flow_count, '| rules:', health.rules);
  } catch (e) {
    console.log('Plugin: NOT REACHABLE (', e.message, ')');
    console.log('  → Run: pbmockx fix');
  }
  // Check npm link
  try {
    execSync('npm ls -g whistle.pbmockx --depth=0', { stdio: 'pipe' });
    console.log('npm link: OK');
  } catch {
    console.log('npm link: NOT LINKED (run: pbmockx fix)');
    if (pluginOk) { /* plugin works but link is broken — pbmockx command might not work */ }
  }
  // Check skill installation (symlink dir → <target>/SKILL.md)
  const skillDir = path.join(PROJECT_ROOT, 'skill');
  const skillTargets = [
    path.join(require('os').homedir(), '.agents/skills/pbmockx'),
    path.join(require('os').homedir(), '.claude/skills/pbmockx'),
  ];
  for (const t of skillTargets) {
    const short = t.replace(require('os').homedir(), '~');
    try {
      const st = fs.lstatSync(t); // lstat: don't follow
      if (!st.isSymbolicLink()) {
        console.log('Skill ' + short + ': NOT SYMLINK (run: pbmockx skill install)');
      } else if (fs.existsSync(t) && fs.existsSync(path.join(t, 'SKILL.md'))) {
        console.log('Skill ' + short + ': OK -> ' + fs.readlinkSync(t));
      } else {
        console.log('Skill ' + short + ': BROKEN -> ' + fs.readlinkSync(t) + ' (run: pbmockx skill install)');
      }
    } catch {
      console.log('Skill ' + short + ': NOT INSTALLED (run: pbmockx skill install)');
    }
  }
  console.log('pbmockx version:', readVersion());
}

async function cmd_fix(args) {
  if (hasHelp(args)) { helpFix(); return; }
  console.log('=== pbmockx fix ===');
  const pluginDir = PLUGIN_ROOT;

  // Step 1: Check if dist/ exists, rebuild if missing
  const distDir = path.join(pluginDir, 'dist');
  if (!fs.existsSync(distDir)) {
    console.log('[1/3] dist/ missing — rebuilding...');
    try {
      execSync('npm install', { cwd: pluginDir, stdio: 'inherit' });
      execSync('npx tsc', { cwd: pluginDir, stdio: 'inherit' });
      console.log('  ✓ Built');
    } catch (e) { console.error('  ✗ Build failed:', e.message); process.exit(1); }
  } else {
    console.log('[1/3] dist/ exists — skip build');
  }

  // Step 2: Re-link npm
  console.log('[2/4] Re-linking npm...');
  try {
    execSync('npm link', { cwd: pluginDir, stdio: 'pipe' });
    console.log('  ✓ npm link OK');
  } catch (e) {
    console.error('  ✗ npm link failed (try: sudo npm link)', e.message);
    process.exit(1);
  }

  // Step 3: Patch whistle frontend (custom inspector-tab hidden bug, >= 2.10.8)
  console.log('[3/4] Checking whistle frontend patch...');
  const patchScript = path.join(PROJECT_ROOT, 'scripts', 'patch-whistle.sh');
  if (fs.existsSync(patchScript)) {
    try {
      execSync('bash ' + patchScript, { stdio: 'inherit' });
    } catch (e) {
      console.error('  ✗ whistle patch failed (non-fatal):', e.message);
    }
  } else {
    console.log('  - patch-whistle.sh not found, skip');
  }

  // Step 4: Restart whistle
  console.log('[4/4] Restarting whistle...');
  try {
    execSync('w2 restart', { stdio: 'pipe' });
    console.log('  ✓ whistle restarted');
  } catch {
    try {
      execSync('w2 start', { stdio: 'pipe' });
      console.log('  ✓ whistle started');
    } catch (e2) {
      console.error('  ✗ whistle start failed:', e2.message);
      process.exit(1);
    }
  }

  // Wait for whistle to load plugin
  await new Promise(r => setTimeout(r, 2000));

  // Verify
  try {
    const health = await _req('GET', '/cgi-bin/health');
    if (health.ok) {
      console.log('\n✓ Plugin recovered! flows:', health.flow_count, 'rules:', health.rules);
    } else {
      console.error('\n✗ Plugin still not healthy. Check: w2 start, or Web UI Plugins page');
    }
  } catch (e) {
    console.error('\n✗ Plugin not reachable after fix. Check:');
    console.error('  1. whistle running: w2 status');
    console.error('  2. plugin installed: w2 install ' + pluginDir);
    console.error('  3. Web UI Plugins page — is whistle.pbmockx enabled?');
  }
}

function cmd_agent_doc(args) {
  if (hasHelp(args)) { helpAgentDoc(); return; }
  console.log(readSkillDoc());
}

function cmd_skill(args) {
  const sub = args[0];
  if (hasHelp(args) || !sub) { helpSkill(); return; }
  const home = require('os').homedir();
  const skillDir = path.join(PROJECT_ROOT, 'skill');
  const targets = [
    path.join(home, '.agents/skills/pbmockx'),
    path.join(home, '.claude/skills/pbmockx'),
  ];
  // remove a stale target (file, symlink, or real dir); no-op if absent
  function cleanTarget(p) {
    try {
      const st = fs.lstatSync(p); // lstat: don't follow symlinks
      if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch { /* not present */ }
  }
  if (sub === 'install') {
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      console.error('skill dir not found at', skillDir);
      process.exit(1);
    }
    for (const target of targets) {
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
      cleanTarget(target);
      try {
        fs.symlinkSync(skillDir, target); // symlink the whole dir → <target>/SKILL.md resolves
        console.log('Installed:', target, '->', skillDir);
      } catch (e) {
        console.error('Failed:', target, e.message);
      }
    }
  } else if (sub === 'list') {
    let found = false;
    for (const p of targets) {
      try {
        const st = fs.lstatSync(p);
        found = true;
        if (st.isSymbolicLink()) {
          console.log('Found:', p, '->', fs.readlinkSync(p));
        } else {
          console.log('Found (not symlink):', p);
        }
      } catch { /* not installed */ }
    }
    if (!found) console.log('(none)');
  } else if (sub === 'uninstall') {
    for (const p of targets) {
      cleanTarget(p);
      try { console.log('Removed:', p); } catch {}
    }
  } else {
    helpSkill();
  }
}

async function cmd_version(args) {
  if (hasHelp(args)) { helpVersion(); return; }
  const ver = readVersion();
  console.log('pbmockx', ver);
  if (args.includes('--check')) {
    try {
      const data = await new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/zztmercury/pbmockx/releases/latest',
          { headers: { 'User-Agent': 'pbmockx' } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
          }).on('error', reject);
      });
      if (data && data.tag_name) {
        const latest = data.tag_name.replace(/^v/, '');
        if (latest !== ver) console.log('Latest:', latest, '(update available)');
        else console.log('Up to date');
      }
    } catch (e) { console.log('Remote check failed:', e.message); }
  }
}

// --- Main dispatcher ---

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    helpMain();
    process.exit(0);
  }
  try {
    switch (cmd) {
      case 'flows': await cmd_flows(args); break;
      case 'decode': await cmd_decode(args); break;
      case 'rules': await cmd_rules(args); break;
      case 'map-local': await cmd_map_local(args); break;
      case 'map-remote': await cmd_map_remote(args); break;
      case 'web': cmd_web(args); break;
      case 'connect-android': await cmd_connect_android(args); break;
      case 'doctor': await cmd_doctor(args); break;
      case 'fix': await cmd_fix(args); break;
      case 'agent-doc': cmd_agent_doc(args); break;
      case 'skill': cmd_skill(args); break;
      case 'version': await cmd_version(args); break;
      default:
        console.error('Unknown command:', cmd);
        console.log('Run: pbmockx --help');
        process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { subjectHashOld, classifyProxyState, classifyCertState, parseDevices };
