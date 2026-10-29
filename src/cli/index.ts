/**
 * pbmockx CLI — command dispatcher.
 *
 * Behavior is intentionally close to the whistle-plugin era CLI: the same
 * commands, flags, default output columns and exit codes. New commands cover
 * the native daemon lifecycle and CA management.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import * as https from 'https';

import {
  localAddresses,
  packageRoot,
  paths,
  readVersion,
  resolveHost,
  resolvePort,
} from '../core/config';
import { client, health, ApiClient } from './api';
import {
  _buildPatchRule,
  _parseRulesAddArgs,
  _renderRuleValue,
  parseValue,
} from './args';
import { detectCert, detectProxy, listDevices, subjectHashOld } from './android';
import {
  cmdCa,
  cmdLogs,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  openUrl,
  waitForHealth,
} from './lifecycle';
import { printSection, printTable, printTunnel } from './render';
import * as help from './help';

const ROOT = packageRoot();

// --- argv helpers ---

function hasHelp(args: string[]): boolean {
  return args.includes('-h') || args.includes('--help');
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function positionals(args: string[], valuedFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valuedFlags.includes(a)) { i++; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

function usageError(msg: string): never {
  console.error('Error: ' + msg);
  process.exit(1);
}

// --- commands ---

async function cmdFlows(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpFlows(); return; }
  const filter = flagValue(args, '--filter');
  const qs = filter ? '?filter=' + encodeURIComponent(filter) : '';
  const data = await client().get('/flows' + qs);
  if (args.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printTable(
    (data || []).map((r: any) => ({
      id: r.id,
      method: r.method,
      status: r.status || '',
      proto: r.tunnel ? 'tunnel' : [r.reqProto, r.resProto].filter(Boolean).join('/'),
      url: (r.url || '').slice(0, 70),
    }))
  );
}

async function cmdDecode(args: string[]): Promise<void> {
  if (hasHelp(args) || !args.filter((a) => !a.startsWith('-')).length) { help.helpDecode(); return; }
  const id = positionals(args, ['--path'])[0];
  if (!id) { help.helpDecode(); process.exit(1); }

  const wantReq = args.includes('--req');
  const wantRes = args.includes('--res');
  const original = args.includes('--original');
  const fullExpand = args.includes('--full');
  const showHeaders = args.includes('--headers');
  const subPath = flagValue(args, '--path');
  const qs = original ? '?original=1' : '';
  const data = await client().get('/flows/' + encodeURIComponent(id) + qs);
  if (args.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.tunnel) {
    printTunnel(data);
    return;
  }

  if (data.error && !data.reqData && !data.resData) {
    console.error('Error:', data.error);
    process.exit(1);
  }

  const showReq = wantReq || (!wantRes && data.hasReq);
  const showRes = wantRes || (!wantReq && data.hasRes);

  if (showReq && (data.reqHeaders || data.reqData !== undefined)) {
    printSection({
      title: 'Request',
      methodLine: data.method,
      url: data.url,
      headers: data.reqHeaders,
      protocol: data.reqProtocol,
      messageType: data.reqMessageType,
      body: data.reqData,
      original,
      path: subPath,
      fullExpand,
      showHeaders,
      decodeError: data.reqDecodeError,
    });
    if (showRes) console.log('');
  }
  if (showRes && (data.resHeaders || data.resData !== undefined)) {
    printSection({
      title: 'Response',
      methodLine: 'HTTP ' + (data.status || 200),
      url: data.url,
      headers: data.resHeaders,
      protocol: data.resProtocol,
      messageType: data.resMessageType,
      body: data.resData,
      original,
      path: subPath,
      fullExpand,
      showHeaders,
      decodeError: data.resDecodeError,
    });
  }
  if (data.patchError) console.error('patch_error:', data.patchError);
  if (data.decodeError) console.error('decode_error:', data.decodeError);
}

async function cmdRules(args: string[]): Promise<void> {
  const sub = args[0];
  if (hasHelp(args) || !sub) { help.helpRules(); return; }
  if (sub === 'add') {
    const parsed = _parseRulesAddArgs(args.slice(1));
    const rule = _buildPatchRule(parsed);
    const result = await client().post('/rules', rule);
    console.log('Rule added:', result.rule.id, result.rule.url_pattern, result.rule.path, '=>', _renderRuleValue(result.rule, parsed.action));
    return;
  }
  if (sub === 'list') {
    const type = flagValue(args, '--type');
    const data = await client().get('/rules' + (type ? '?type=' + encodeURIComponent(type) : ''));
    if (args.includes('--json')) { console.log(JSON.stringify(data, null, 2)); return; }
    printTable(
      (data || []).map((r: any) => {
        let pathCol = r.path || r.replacement || r.file_path || '';
        if (r.type === 'patch' && r.action && r.action !== 'set') {
          pathCol += ' [' + r.action + (r.index !== undefined ? ' ' + r.index : '') + ']';
        }
        let valueCol = '';
        if (r.action === 'unset') valueCol = '(unset)';
        else if (r.value !== undefined) valueCol = JSON.stringify(r.value);
        return {
          id: r.id,
          type: r.type,
          url: (r.url_pattern || '').slice(0, 50),
          path: pathCol,
          value: valueCol,
        };
      })
    );
    return;
  }
  if (sub === 'del') {
    const id = positionals(args.slice(1))[0];
    if (!id) usageError('Usage: pbmockx rules del <id>');
    const result = await client().del('/rules/' + encodeURIComponent(id));
    console.log('Deleted:', result.ok);
    return;
  }
  if (sub === 'save') {
    const result = await client().post('/rules/save', {});
    console.log('Saved:', result.ok);
    return;
  }
  if (sub === 'reload') {
    const result = await client().post('/rules/reload', {});
    console.log('Reloaded:', result.reloaded, 'rules');
    return;
  }
  help.helpRules();
}

async function cmdMapLocal(args: string[]): Promise<void> {
  const sub = args[0];
  if (hasHelp(args) || !sub) { help.helpMapLocal(); return; }
  if (sub === 'add') {
    const url = positionals(args, ['--data', '--file', '--desc', '--messageType', '--status']).filter((a) => a !== 'add')[0];
    if (!url) usageError('Usage: pbmockx map-local add <url> --data <json> | --file <path>');
    const dataRaw = flagValue(args, '--data');
    const filePath = flagValue(args, '--file');
    const desc = flagValue(args, '--desc');
    const messageType = flagValue(args, '--messageType');
    const status = flagValue(args, '--status');
    const rule: any = { type: 'map_local', url_pattern: url };
    if (dataRaw !== undefined) {
      try { rule.data = JSON.parse(dataRaw); } catch (e: any) { usageError('--data must be valid JSON: ' + e.message); }
      rule.source = 'data';
    } else if (filePath) {
      rule.file_path = filePath;
      rule.source = 'file';
    } else {
      usageError('Either --data or --file is required');
    }
    if (desc) rule.desc = desc;
    if (messageType) rule.messageType = messageType;
    if (args.includes('--delimited')) rule.delimited = true;
    if (status) rule.status = parseInt(status, 10);
    const result = await client().post('/map-local', rule);
    console.log('Map local added:', result.rule.id, result.rule.url_pattern);
    return;
  }
  if (sub === 'list') {
    const data = await client().get('/rules?type=map_local');
    if (args.includes('--json')) { console.log(JSON.stringify(data, null, 2)); return; }
    printTable((data || []).map((r: any) => ({
      id: r.id,
      url: (r.url_pattern || '').slice(0, 50),
      source: r.source || '',
      file: (r.file_path || r.data_file || '').slice(0, 40),
    })));
    return;
  }
  if (sub === 'del') {
    const id = positionals(args.slice(1))[0];
    if (!id) usageError('Usage: pbmockx map-local del <id>');
    const result = await client().del('/rules/' + encodeURIComponent(id));
    console.log('Deleted:', result.ok);
    return;
  }
  help.helpMapLocal();
}

async function cmdMapRemote(args: string[]): Promise<void> {
  const sub = args[0];
  if (hasHelp(args) || !sub) { help.helpMapRemote(); return; }
  if (sub === 'add') {
    const pos = positionals(args).filter((a) => a !== 'add');
    const url = pos[0];
    const replacement = pos[1];
    if (!url || !replacement) usageError('Usage: pbmockx map-remote add <url> <replacement> [--regex]');
    const rule = { type: 'map_remote', url_pattern: url, replacement, is_regex: args.includes('--regex') };
    const result = await client().post('/rules', rule);
    console.log('Map remote added:', result.rule.id, result.rule.url_pattern, '=>', result.rule.replacement);
    return;
  }
  if (sub === 'list') {
    const data = await client().get('/rules?type=map_remote');
    if (args.includes('--json')) { console.log(JSON.stringify(data, null, 2)); return; }
    printTable((data || []).map((r: any) => ({
      id: r.id,
      url: (r.url_pattern || '').slice(0, 50),
      replacement: (r.replacement || '').slice(0, 50),
      regex: r.is_regex ? 'Y' : '',
    })));
    return;
  }
  if (sub === 'del') {
    const id = positionals(args.slice(1))[0];
    if (!id) usageError('Usage: pbmockx map-remote del <id>');
    const result = await client().del('/rules/' + encodeURIComponent(id));
    console.log('Deleted:', result.ok);
    return;
  }
  help.helpMapRemote();
}

async function cmdWeb(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpWeb(); return; }
  const port = resolvePort();
  const url = 'http://' + resolveHost() + ':' + port + '/';
  console.log('Opening', url);
  openUrl(url);
}

async function cmdConnectAndroid(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpConnectAndroid(); return; }
  const serial = flagValue(args, '-s') || null;
  const port = resolvePort();
  const wifiIdx = args.indexOf('--wifi');
  let wifiHost: string | null = null;
  if (wifiIdx >= 0) {
    const next = args[wifiIdx + 1];
    wifiHost = next && !next.startsWith('-') ? next : (localAddresses()[0] || null);
    if (!wifiHost) {
      console.error('Error: no non-internal IPv4 address found for --wifi; pass an explicit host.');
      process.exit(1);
    }
  }

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
    if (devices[0].state !== 'device') {
      console.error('Error: device ' + devices[0].serial + ' is ' + devices[0].state + ' (not ready).');
      console.error('Authorize the RSA fingerprint on the device, or reconnect and retry.');
      process.exit(1);
    }
  }

  const adbExec = (cmd: string): boolean => {
    const full = (serial ? 'adb -s ' + serial + ' ' : 'adb ') + cmd;
    console.log('[exec] ' + full);
    try { execSync(full, { stdio: 'pipe' }); return true; }
    catch (e: any) { console.error('  failed: ' + String(e.message).split('\n')[0]); return false; }
  };

  console.log('=== Step 1: Configure proxy (executed) ===');
  if (wifiHost) {
    console.log('Wi-Fi mode: using ' + wifiHost + ':' + port + ' (no adb reverse)');
    adbExec('shell settings put global http_proxy ' + wifiHost + ':' + port);
  } else {
    adbExec('reverse tcp:' + port + ' tcp:' + port);
    adbExec('shell settings put global http_proxy 127.0.0.1:' + port);
  }

  console.log('\n=== Step 2: Detect status (read-only) ===');
  const proxy = detectProxy(serial, port);
  console.log('Proxy: ' + proxy.state + (proxy.raw ? ' [' + proxy.raw + ']' : '') +
    (proxy.state === 'mismatch' ? ' (expected ' + proxy.expected + ')' : ''));

  const p = paths();
  let cert: any = null;
  let certState = 'unknown';
  if (!fs.existsSync(p.caCertFile)) {
    console.log('Cert status:   unknown (CA not generated yet — run: pbmockx start)');
  } else {
    try {
      const pem = fs.readFileSync(p.caCertFile, 'utf-8');
      const hash = subjectHashOld(pem);
      console.log('CA hash: ' + hash);
      cert = detectCert(serial, hash);
      certState = cert.state;
      const sysHit = cert.system.find((d: any) => d.found);
      const usrHit = cert.user.find((d: any) => d.found);
      const sysDenied = cert.system.some((d: any) => d.denied);
      console.log('Cert (system): ' + (sysHit ? 'found @ ' + sysHit.dir : (sysDenied ? 'cannot check (permission denied)' : 'not found')));
      console.log('Cert (user):   ' + (usrHit ? 'found @ ' + usrHit.dir : (cert.root ? 'not found' : 'requires root (su) to check')));
      console.log('Cert status:   ' + certState);
    } catch (e: any) {
      console.log('Cert status:   unknown (CA read failed: ' + e.message + ')');
    }
  }

  if (certState === 'user') {
    console.log('\n  WARNING: installed as USER certificate.');
    console.log('  Android 7+ apps (targetSdk>=24) do NOT trust user certs by default.');
    console.log('  Install as a SYSTEM cert (root / Magisk / emulator) or configure');
    console.log('  networkSecurityConfig in the app.');
  } else if (certState === 'not_found') {
    console.log('\n  Manual steps to install (NOT executed by this command):');
    console.log('  1. Download: http://' + (wifiHost || '127.0.0.1') + ':' + port + '/__pbmockx/api/ca.pem');
    console.log('  2. adb push ' + p.caCertFile + ' /sdcard/pbmockx-ca.crt');
    console.log('  3. Settings > Security > Encryption & credentials > Install from storage');
    console.log('  Re-run: pbmockx connect-android' + (serial ? ' -s ' + serial : '') + '  (after install)');
  } else if (certState === 'unknown') {
    console.log('\n  Cannot automatically confirm cert status:');
    if (!cert || !cert.root) {
      console.log('  - System cert: not installed');
      console.log('  - User cert:   cannot check without root (su) — the user-cert');
      console.log('    directory is protected by SELinux on non-root devices.');
    } else {
      console.log('  (permission denied or device offline)');
    }
    console.log('  Verify manually: Settings > Security > Encryption & credentials >');
    console.log('    Trusted credentials > User tab (look for "pbmockx local CA").');
    console.log('  Note: a USER cert is NOT trusted by apps targeting Android 7+ unless');
    console.log('  the app uses networkSecurityConfig. For reliable HTTPS capture, install');
    console.log('  as a SYSTEM cert (root / Magisk) or use an emulator.');
  } else if (certState === 'system') {
    console.log('\n  Cert installed as SYSTEM certificate — apps should trust it.');
  }
}

async function cmdDoctor(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpDoctor(); return; }
  const p = paths();
  const port = resolvePort(p);
  const rows: Array<{ name: string; status: 'OK' | 'WARN' | 'FAIL'; detail: string }> = [];
  const add = (name: string, status: 'OK' | 'WARN' | 'FAIL', detail: string) => rows.push({ name, status, detail });

  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('node', major >= 18 ? 'OK' : 'FAIL', process.version + (major >= 18 ? '' : ' (need >= 18)'));

  try {
    fs.mkdirSync(p.dataDir, { recursive: true });
    const probe = path.join(p.dataDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('data dir', 'OK', p.dataDir);
  } catch (e: any) {
    add('data dir', 'FAIL', p.dataDir + ' — ' + e.message);
  }

  add('CA', fs.existsSync(p.caCertFile) ? 'OK' : 'WARN', fs.existsSync(p.caCertFile) ? p.caCertFile : 'not generated yet (run: pbmockx start)');

  let info: any = null;
  try {
    info = await health(port, resolveHost(p));
    add('daemon', 'OK', `http://127.0.0.1:${port} | flows: ${info.flow_count} | rules: ${info.rules}`);
    if (info.flow_count === 0) add('traffic', 'WARN', 'no flows captured yet — configure the proxy and trigger a request');
  } catch (e: any) {
    add('daemon', 'FAIL', e.message);
    add('fix', 'WARN', 'run: pbmockx fix');
  }

  try {
    const w2 = execSync('w2 --version', { stdio: 'pipe', timeout: 3000 }).toString().trim();
    add('legacy whistle', 'WARN', `${w2} installed — pbmockx no longer uses it; stop it if it occupies port ${port}`);
  } catch {
    add('legacy whistle', 'OK', 'not installed');
  }

  const skillTargets = [
    path.join(os.homedir(), '.agents/skills/pbmockx'),
    path.join(os.homedir(), '.claude/skills/pbmockx'),
  ];
  for (const t of skillTargets) {
    const short = t.replace(os.homedir(), '~');
    try {
      const st = fs.lstatSync(t);
      if (!st.isSymbolicLink()) add('skill', 'WARN', short + ' is not a symlink (run: pbmockx skill install)');
      else if (fs.existsSync(path.join(t, 'SKILL.md'))) add('skill', 'OK', short + ' -> ' + fs.readlinkSync(t));
      else add('skill', 'WARN', short + ' broken -> ' + fs.readlinkSync(t));
    } catch {
      add('skill', 'WARN', short + ' not installed (run: pbmockx skill install)');
    }
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ version: readVersion(p), port, checks: rows }, null, 2));
    return;
  }

  console.log('=== pbmockx doctor ===');
  console.log('version:', readVersion(p));
  for (const r of rows) {
    const tag = r.status === 'OK' ? '[ OK ]' : r.status === 'WARN' ? '[WARN]' : '[FAIL]';
    console.log(`${tag} ${r.name}: ${r.detail}`);
  }
  if (rows.some((r) => r.status === 'FAIL')) {
    console.log('\nNext: pbmockx fix   (rebuild + restart + verify)');
  }
}

async function cmdFix(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpFix(); return; }
  console.log('=== pbmockx fix ===');
  console.log('[1/3] Building...');
  // `fix` rebuilds from source, which only exists in a git checkout. Installs
  // from npm ship compiled dist/ and no TypeScript sources.
  if (!fs.existsSync(path.join(ROOT, 'tsconfig.json'))) {
    console.error('  this install has no TypeScript sources (installed from npm).');
    console.error('  upgrade instead: npm i -g pbmockx@latest && pbmockx restart');
    process.exit(1);
  }
  try {
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
      console.log('  node_modules missing — installing dependencies...');
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    }
    execSync('npx tsc -p tsconfig.json', { cwd: ROOT, stdio: 'inherit' });
    console.log('  build OK');
  } catch (e: any) {
    console.error('  build failed:', e.message);
    process.exit(1);
  }

  console.log('[2/3] Restarting daemon...');
  const p = paths();
  const rt = (() => { try { return JSON.parse(fs.readFileSync(p.runtimeFile, 'utf-8')); } catch { return null; } })();
  try {
    if (rt) await cmdRestart({ dataDir: p.dataDir, port: rt.port });
    else await cmdStart({ dataDir: p.dataDir });
  } catch (e: any) {
    console.error('  restart failed:', e.message);
    process.exit(1);
  }

  console.log('[3/3] Verifying...');
  const ok = await waitForHealth(resolvePort(p), 10000, resolveHost(p));
  if (!ok) {
    console.error('  daemon is not healthy. Last log lines:');
    try { console.error(fs.readFileSync(p.logFile, 'utf-8').split('\n').slice(-20).join('\n')); } catch {}
    process.exit(1);
  }
  console.log(`\nOK — daemon healthy | flows: ${ok.flow_count} | rules: ${ok.rules}`);
}

function readSkillDoc(): string {
  const p = paths();
  const content = fs.readFileSync(p.skillFile, 'utf-8');
  return content.replace(/^---[\s\S]*?---\n/, '');
}

function cmdAgentDoc(args: string[]): void {
  if (hasHelp(args)) { help.helpAgentDoc(); return; }
  console.log(readSkillDoc());
}

function cmdSkill(args: string[]): void {
  const sub = args[0];
  if (hasHelp(args) || !sub) { help.helpSkill(); return; }
  const home = os.homedir();
  const skillDir = path.join(ROOT, 'skill');
  const targets = [
    path.join(home, '.agents/skills/pbmockx'),
    path.join(home, '.claude/skills/pbmockx'),
  ];
  const cleanTarget = (p: string) => {
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch {}
  };
  if (sub === 'install') {
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      console.error('skill dir not found at', skillDir);
      process.exit(1);
    }
    for (const target of targets) {
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
      cleanTarget(target);
      try {
        fs.symlinkSync(skillDir, target);
        console.log('Installed:', target, '->', skillDir);
      } catch (e: any) {
        console.error('Failed:', target, e.message);
      }
    }
    return;
  }
  if (sub === 'list') {
    let found = false;
    for (const p of targets) {
      try {
        const st = fs.lstatSync(p);
        found = true;
        console.log(st.isSymbolicLink() ? 'Found: ' + p + ' -> ' + fs.readlinkSync(p) : 'Found (not symlink): ' + p);
      } catch {}
    }
    if (!found) console.log('(none)');
    return;
  }
  if (sub === 'uninstall') {
    for (const p of targets) {
      cleanTarget(p);
      console.log('Removed:', p);
    }
    return;
  }
  help.helpSkill();
}

async function cmdVersion(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpVersion(); return; }
  const p = paths();
  const ver = readVersion(p);
  console.log('pbmockx', ver);
  if (!args.includes('--check')) return;
  try {
    const data: any = await new Promise((resolve, reject) => {
      const req = https.get('https://api.github.com/repos/zztmercury/pbmockx/releases/latest',
        { headers: { 'User-Agent': 'pbmockx' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); }
          });
        });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });
    if (data && data.tag_name) {
      const latest = String(data.tag_name).replace(/^v/, '');
      console.log(latest !== ver ? `Latest: ${latest} (update available)` : 'Up to date');
    }
  } catch (e: any) {
    console.log('Remote check failed:', e.message);
  }
}

// --- dispatcher ---

function stripGlobal(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') {
      if (argv[i + 1]) {
        process.env.PBMOCKX_DATA_DIR = path.resolve(argv[i + 1]);
        i++;
      }
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

export async function main(argv: string[]): Promise<void> {
  argv = stripGlobal(argv);
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    help.helpMain();
    return;
  }

  switch (cmd) {
    case 'flows': await cmdFlows(args); return;
    case 'decode': await cmdDecode(args); return;
    case 'rules': await cmdRules(args); return;
    case 'map-local': await cmdMapLocal(args); return;
    case 'map-remote': await cmdMapRemote(args); return;
    case 'web': await cmdWeb(args); return;
    case 'connect-android': await cmdConnectAndroid(args); return;
    case 'doctor': await cmdDoctor(args); return;
    case 'fix': await cmdFix(args); return;
    case 'agent-doc': cmdAgentDoc(args); return;
    case 'skill': cmdSkill(args); return;
    case 'version': await cmdVersion(args); return;

    case 'start': {
      if (hasHelp(args)) { help.helpStart(); return; }
      await cmdStart({
        port: flagValue(args, '--port') ? parseInt(flagValue(args, '--port')!, 10) : undefined,
        host: flagValue(args, '--host'),
        foreground: args.includes('--foreground'),
        lan: args.includes('--lan'),
      });
      return;
    }
    case 'stop': {
      if (hasHelp(args)) { help.helpStop(); return; }
      await cmdStop({});
      return;
    }
    case 'restart': {
      if (hasHelp(args)) { help.helpRestart(); return; }
      await cmdRestart({
        port: flagValue(args, '--port') ? parseInt(flagValue(args, '--port')!, 10) : undefined,
        host: flagValue(args, '--host'),
        lan: args.includes('--lan'),
      });
      return;
    }
    case 'status': {
      if (hasHelp(args)) { help.helpStatus(); return; }
      await cmdStatus({ json: args.includes('--json') });
      return;
    }
    case 'logs': {
      if (hasHelp(args)) { help.helpLogs(); return; }
      await cmdLogs({
        follow: args.includes('-f') || args.includes('--follow'),
        lines: flagValue(args, '-n') ? parseInt(flagValue(args, '-n')!, 10) : undefined,
      });
      return;
    }
    case 'ca': {
      if (hasHelp(args)) { help.helpCa(); return; }
      await cmdCa({
        out: flagValue(args, '--out'),
        info: args.includes('--info'),
        regen: args.includes('--regen'),
        yes: args.includes('--yes'),
      });
      return;
    }
    default:
      console.error('Unknown command:', cmd);
      console.log('Run: pbmockx --help');
      process.exit(1);
  }
}

export { parseValue, ApiClient, health };
