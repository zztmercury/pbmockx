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
  connect-android [-s <serial>]   Configure Android proxy + cert
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
  console.log(`Usage: pbmockx decode <id> [--req|--res] [--original]

Show flow details: headers + decoded body (PB field tree or JSON).

Arguments:
  id                              Flow ID (from 'pbmockx flows')

Options:
  --req                           Show only request headers + body
  --res                           Show only response headers + body
  --original                      Show original (pre-patch) data instead of patched
  -h, --help                      Show this help

Examples:
  pbmockx decode abc123
  pbmockx decode abc123 --res
  pbmockx decode abc123 --original`);
}

function helpRules() {
  console.log(`Usage: pbmockx rules <subcommand> [args]

Subcommands:
  add <url> <path> <value> [--protocol pb|json]  Add patch rule
  list [--type patch|map_local|map_remote]       List rules
  del <id>                                        Delete rule by ID
  save                                            Save rules to rules.yaml
  reload                                          Reload rules from rules.yaml

Options:
  -h, --help                      Show this help

Examples:
  pbmockx rules add 'api/game' game.name TestName --protocol pb
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
function helpConnectAndroid() { console.log(`Usage: pbmockx connect-android [-s <serial>]\n\nConfigure Android device proxy + cert.`); }
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
  const skillPath = path.join(PROJECT_ROOT, 'docs', 'SKILL.md');
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
    dir: r.direction === 'req' ? 'REQ' : 'RES',
    method: r.method,
    status: r.status || '',
    protocol: r.protocol || '',
    messageType: (r.messageType || '').slice(0, 40),
    url: (r.url || '').slice(0, 60),
  })));
}

async function cmd_decode(args) {
  if (hasHelp(args) || args.length === 0) { helpDecode(); return; }
  const id = args.find(a => !a.startsWith('-'));
  if (!id) { helpDecode(); process.exit(1); }

  const wantReq = args.includes('--req');
  const wantRes = args.includes('--res');
  const original = args.includes('--original');
  const qs = original ? '?original=1' : '';
  const data = await _req('GET', '/cgi-bin/flows/' + id + qs);

  if (data.error && !data.data) { console.error('Error:', data.error); process.exit(1); }

  // resRead flow → show response; reqRead flow → show request
  // --req: find matching reqRead flow; --res: find matching resRead flow
  if (wantReq && data.direction === 'res') {
    // Find the matching reqRead flow by URL
    const baseUrl = data.url;
    const allFlows = await _req('GET', '/cgi-bin/flows');
    const reqFlow = allFlows.find(f => f.direction === 'req' && f.url.startsWith(baseUrl));
    if (reqFlow) {
      const reqData = await _req('GET', '/cgi-bin/flows/' + reqFlow.id + qs);
      printSection('Request', reqData.method, reqData.url, reqData.reqHeaders, reqData, original);
      return;
    }
    console.log('(no matching request flow)');
    return;
  }
  if (wantRes && data.direction === 'req') {
    const baseUrl = data.url.replace(' (request)$', '');
    const allFlows = await _req('GET', '/cgi-bin/flows');
    const resFlow = allFlows.find(f => f.direction === 'res' && baseUrl.includes(f.url));
    if (resFlow) {
      const resData = await _req('GET', '/cgi-bin/flows/' + resFlow.id + qs);
      printSection('Response', 'HTTP ' + (resData.status || 200), resData.url, resData.resHeaders, resData, original);
      return;
    }
    console.log('(no matching response flow)');
    return;
  }

  // Default: show what's available
  if (data.direction === 'req') {
    printSection('Request', data.method, data.url, data.reqHeaders, data, original);
  } else {
    printSection('Response', 'HTTP ' + (data.status || 200), data.url, data.resHeaders, data, original);
  }
}

function printSection(title, methodLine, url, headers, data, original) {
  console.log('=== ' + title + ' ===');
  console.log(methodLine + ' ' + (url || '').replace(' (request)$', ''));
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      console.log(k + ': ' + v);
    }
  }
  console.log('');
  if (data.data) {
    const label = data.protocol === 'json' ? title + ' Body (JSON)' : title + ' Body (PB: ' + (data.messageType || '?') + ')';
    console.log('=== ' + label + (original ? ' [original]' : '') + ' ===');
    if (data.protocol === 'json') {
      console.log(JSON.stringify(data.data, null, 2));
    } else if (data.data && data.data.fields) {
      try {
        const { renderTree } = require('../dist/src/field-tree');
        console.log(renderTree(data.data));
      } catch { console.log(JSON.stringify(data.data, null, 2)); }
    }
  }
  if (data.error) console.error('Error:', data.error);
}

async function cmd_rules(args) {
  const sub = args[0];
  if (hasHelp(args) || !sub) { helpRules(); return; }
  if (sub === 'add') {
    const url = args.find(a => !a.startsWith('-') && a !== 'add');
    const rulePath = args.find((a, i) => i > 0 && !a.startsWith('-') && a !== url);
    const value = args.find((a, i) => i > args.indexOf(rulePath) && !a.startsWith('-'));
    if (!url || !rulePath) { console.error('Usage: pbmockx rules add <url> <path> <value> [--protocol pb|json]'); process.exit(1); }
    const protoIdx = args.indexOf('--protocol');
    const protocol = protoIdx >= 0 ? args[protoIdx + 1] : undefined;
    const rule = { type: 'patch', url_pattern: url, path: rulePath, value: _parseValue(value) };
    if (protocol) rule.protocol = protocol;
    const result = await _req('POST', '/cgi-bin/rules', rule);
    console.log('Rule added:', result.rule.id, result.rule.url_pattern, result.rule.path, '=>', result.rule.value);
  } else if (sub === 'list') {
    const typeIdx = args.indexOf('--type');
    const type = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
    const qs = type ? '?type=' + type : '';
    const data = await _req('GET', '/cgi-bin/rules' + qs);
    printTable(data.map(r => ({ id: r.id, type: r.type, url: (r.url_pattern || '').slice(0, 50), path: r.path || r.replacement || r.file_path || '', value: r.value !== undefined ? JSON.stringify(r.value) : '' })));
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

function cmd_connect_android(args) {
  if (hasHelp(args)) { helpConnectAndroid(); return; }
  const serialIdx = args.indexOf('-s');
  const serial = serialIdx >= 0 ? args[serialIdx + 1] : null;
  const adb = (cmd) => {
    const full = serial ? 'adb -s ' + serial + ' ' + cmd : 'adb ' + cmd;
    console.log('$', full);
    try { return execSync(full, { stdio: 'pipe' }).toString().trim(); }
    catch (e) { console.error('adb failed:', e.message); return null; }
  };
  const port = WHISTLE_PORT;
  console.log('Setting up Android proxy to 127.0.0.1:' + port + '...');
  adb('reverse tcp:' + port + ' tcp:' + port);
  adb('shell settings put global http_proxy 127.0.0.1:' + port);
  console.log('\nTo install whistle root CA on Android:');
  console.log('  1. Download: http://127.0.0.1:' + port + '/cgi-bin/rootca');
  console.log('  2. adb push rootCA.crt /sdcard/');
  console.log('  3. Settings > Security > Install from storage');
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
  console.log('[2/3] Re-linking npm...');
  try {
    execSync('npm link', { cwd: pluginDir, stdio: 'pipe' });
    console.log('  ✓ npm link OK');
  } catch (e) {
    console.error('  ✗ npm link failed (try: sudo npm link)', e.message);
    process.exit(1);
  }

  // Step 3: Restart whistle
  console.log('[3/3] Restarting whistle...');
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
  if (sub === 'install') {
    const skillSrc = path.join(PROJECT_ROOT, 'docs', 'SKILL.md');
    if (!fs.existsSync(skillSrc)) { console.error('SKILL.md not found at', skillSrc); process.exit(1); }
    const targets = [
      path.join(require('os').homedir(), '.agents/skills/pbmockx'),
      path.join(require('os').homedir(), '.claude/skills/pbmockx'),
    ];
    for (const target of targets) {
      const targetDir = path.dirname(target);
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
      try {
        if (fs.existsSync(target) || fs.existsSync(target + '.md')) {
          fs.unlinkSync(fs.existsSync(target) ? target : target + '.md');
        }
        fs.symlinkSync(skillSrc, target);
        console.log('Installed:', target);
      } catch (e) {
        try {
          fs.copyFileSync(skillSrc, target + '.md');
          console.log('Installed (copy):', target + '.md');
        } catch (e2) { console.error('Failed:', target, e2.message); }
      }
    }
  } else if (sub === 'list') {
    const home = require('os').homedir();
    const dirs = ['.agents/skills', '.claude/skills'];
    for (const d of dirs) {
      const p = path.join(home, d, 'pbmockx');
      if (fs.existsSync(p) || fs.existsSync(p + '.md')) {
        console.log('Found:', p);
      }
    }
  } else if (sub === 'uninstall') {
    const home = require('os').homedir();
    const targets = [
      path.join(require('os').homedir(), '.agents/skills/pbmockx'),
      path.join(require('os').homedir(), '.claude/skills/pbmockx'),
    ];
    for (const t of targets) {
      for (const p of [t, t + '.md']) {
        try { fs.unlinkSync(p); console.log('Removed:', p); } catch {}
      }
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
      case 'connect-android': cmd_connect_android(args); break;
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

main();
