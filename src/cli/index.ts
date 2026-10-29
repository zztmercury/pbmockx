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
  patchConfigFile,
  paths,
  readConfigFile,
  readRuntime,
  readVersion,
  resolveHost,
  resolvePort,
} from '../core/config';
import { detectLangFromEnv, normalizeLang } from '../core/lang';
import { getLang, initLang, t, type MsgKey } from '../i18n';
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
    console.log(t('rules.added', {
      id: result.rule.id,
      url: result.rule.url_pattern,
      path: result.rule.path,
      value: _renderRuleValue(result.rule, parsed.action),
    }));
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
    console.log(t('rules.deleted', { ok: result.ok }));
    return;
  }
  if (sub === 'save') {
    const result = await client().post('/rules/save', {});
    console.log(t('rules.saved', { ok: result.ok }));
    return;
  }
  if (sub === 'reload') {
    const result = await client().post('/rules/reload', {});
    console.log(t('rules.reloaded', { count: result.reloaded }));
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
      try { rule.data = JSON.parse(dataRaw); } catch (e: any) { usageError(t('error.dataInvalidJson', { message: e.message })); }
      rule.source = 'data';
    } else if (filePath) {
      rule.file_path = filePath;
      rule.source = 'file';
    } else {
      usageError(t('error.dataOrFile'));
    }
    if (desc) rule.desc = desc;
    if (messageType) rule.messageType = messageType;
    if (args.includes('--delimited')) rule.delimited = true;
    if (status) rule.status = parseInt(status, 10);
    const result = await client().post('/map-local', rule);
    console.log(t('mapLocal.added', { id: result.rule.id, url: result.rule.url_pattern }));
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
    console.log(t('rules.deleted', { ok: result.ok }));
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
    console.log(t('mapRemote.added', {
      id: result.rule.id,
      url: result.rule.url_pattern,
      replacement: result.rule.replacement,
    }));
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
    console.log(t('rules.deleted', { ok: result.ok }));
    return;
  }
  help.helpMapRemote();
}

async function cmdWeb(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpWeb(); return; }
  const port = resolvePort();
  const url = 'http://' + resolveHost() + ':' + port + '/';
  console.log(t('web.opening', { url }));
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
      console.error('Error: ' + t('connect.noLanIp'));
      process.exit(1);
    }
  }

  if (!serial) {
    const devices = listDevices();
    if (devices === null) {
      console.error('Error: ' + t('connect.adbMissing'));
      process.exit(1);
    }
    if (devices.length === 0) {
      console.error('Error: ' + t('connect.noDevice'));
      process.exit(1);
    }
    if (devices.length > 1) {
      console.error('Error: ' + t('connect.multipleDevices', { count: devices.length }));
      console.error(t('connect.availableDevices'));
      for (const d of devices) console.error(t('connect.deviceEntry', { serial: d.serial, state: d.state }));
      process.exit(1);
    }
    if (devices[0].state !== 'device') {
      console.error('Error: ' + t('connect.deviceNotReady', { serial: devices[0].serial, state: devices[0].state }));
      console.error(t('connect.authorizeRsa'));
      process.exit(1);
    }
  }

  const adbExec = (cmd: string): boolean => {
    const full = (serial ? 'adb -s ' + serial + ' ' : 'adb ') + cmd;
    console.log('[exec] ' + full);
    try { execSync(full, { stdio: 'pipe' }); return true; }
    catch (e: any) { console.error('  ' + t('connect.execFailed', { message: String(e.message).split('\n')[0] })); return false; }
  };

  console.log(t('connect.step1'));
  if (wifiHost) {
    console.log(t('connect.wifiMode', { host: wifiHost, port }));
    adbExec('shell settings put global http_proxy ' + wifiHost + ':' + port);
  } else {
    adbExec('reverse tcp:' + port + ' tcp:' + port);
    adbExec('shell settings put global http_proxy 127.0.0.1:' + port);
  }

  console.log('\n' + t('connect.step2'));
  const proxy = detectProxy(serial, port);
  const proxyRaw = proxy.raw ? ' [' + proxy.raw + ']' : '';
  const proxyExpected = proxy.state === 'mismatch' ? t('connect.proxyExpected', { expected: proxy.expected }) : '';
  console.log(t('connect.proxy', { state: proxy.state, raw: proxyRaw, expected: proxyExpected }));

  const p = paths();
  let cert: any = null;
  let certState = 'unknown';
  if (!fs.existsSync(p.caCertFile)) {
    console.log(t('connect.certStatusNoCa'));
  } else {
    try {
      const pem = fs.readFileSync(p.caCertFile, 'utf-8');
      const hash = subjectHashOld(pem);
      console.log(t('connect.caHash', { hash }));
      cert = detectCert(serial, hash);
      certState = cert.state;
      const sysHit = cert.system.find((d: any) => d.found);
      const usrHit = cert.user.find((d: any) => d.found);
      const sysDenied = cert.system.some((d: any) => d.denied);
      console.log(t('connect.certSystem', {
        status: sysHit
          ? t('connect.certFoundAt', { dir: sysHit.dir })
          : (sysDenied ? t('connect.certPermissionDenied') : t('connect.certNotFound')),
      }));
      console.log(t('connect.certUser', {
        status: usrHit
          ? t('connect.certFoundAt', { dir: usrHit.dir })
          : (cert.root ? t('connect.certNotFound') : t('connect.certRequiresRoot')),
      }));
      console.log(t('connect.certStatus', { state: certState }));
    } catch (e: any) {
      console.log(t('connect.certReadFailed', { message: e.message }));
    }
  }

  if (certState === 'user') {
    console.log('\n' + t('connect.warnUserTitle'));
    console.log(t('connect.warnUserBody1'));
    console.log(t('connect.warnUserBody2'));
    console.log(t('connect.warnUserBody3'));
  } else if (certState === 'not_found') {
    console.log('\n' + t('connect.manualTitle'));
    console.log(t('connect.manualStep1', { host: wifiHost || '127.0.0.1', port }));
    console.log(t('connect.manualStep2', { file: p.caCertFile }));
    console.log(t('connect.manualStep3'));
    console.log(t('connect.rerun', { serial: serial ? ' -s ' + serial : '' }));
  } else if (certState === 'unknown') {
    console.log('\n' + t('connect.unknownTitle'));
    if (!cert || !cert.root) {
      console.log(t('connect.unknownSystemCert'));
      console.log(t('connect.unknownUserCert1'));
      console.log(t('connect.unknownUserCert2'));
    } else {
      console.log(t('connect.unknownOffline'));
    }
    console.log(t('connect.unknownVerify1'));
    console.log(t('connect.unknownVerify2'));
    console.log(t('connect.unknownNote1'));
    console.log(t('connect.unknownNote2'));
    console.log(t('connect.unknownNote3'));
  } else if (certState === 'system') {
    console.log('\n' + t('connect.systemOk'));
  }
}

type CheckStatus = 'OK' | 'WARN' | 'FAIL';

/**
 * `--json` is a machine contract, so doctor rows keep canonical English
 * `name`/`detail` values; `label`/`text` are only used by the text listing.
 */
interface DoctorRow {
  name: string;
  status: CheckStatus;
  detail: string;
  label: string;
  text: string;
}

/**
 * `src/cli/api.ts` (outside the i18n scope) emits one fixed English
 * connection-refused message. Recognise it so the CLI can translate it, without
 * touching anything else. Returns the port, or null for unrelated errors.
 */
function daemonDownPort(message: string): number | null {
  const m = /^pbmockx daemon is not running on 127\.0\.0\.1:(\d+)\. Run: pbmockx start$/.exec(message);
  return m ? Number(m[1]) : null;
}

async function cmdDoctor(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpDoctor(); return; }
  const p = paths();
  const port = resolvePort(p);
  const rows: DoctorRow[] = [];
  const add = (name: string, labelKey: MsgKey, status: CheckStatus, detail: string, text = detail) =>
    rows.push({ name, status, detail, label: t(labelKey), text });

  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('node', 'doctor.name.node', major >= 18 ? 'OK' : 'FAIL',
    process.version + (major >= 18 ? '' : ' (need >= 18)'),
    process.version + (major >= 18 ? '' : t('doctor.nodeNeed')));

  try {
    fs.mkdirSync(p.dataDir, { recursive: true });
    const probe = path.join(p.dataDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('data dir', 'doctor.name.dataDir', 'OK', p.dataDir);
  } catch (e: any) {
    add('data dir', 'doctor.name.dataDir', 'FAIL', p.dataDir + ' — ' + e.message);
  }

  const hasCa = fs.existsSync(p.caCertFile);
  add('CA', 'doctor.name.ca', hasCa ? 'OK' : 'WARN',
    hasCa ? p.caCertFile : 'not generated yet (run: pbmockx start)',
    hasCa ? p.caCertFile : t('doctor.caPending'));

  let info: any = null;
  try {
    info = await health(port, resolveHost(p));
    add('daemon', 'doctor.name.daemon', 'OK',
      `http://127.0.0.1:${port} | flows: ${info.flow_count} | rules: ${info.rules}`);
    if (info.flow_count === 0) {
      add('traffic', 'doctor.name.traffic', 'WARN',
        'no flows captured yet — configure the proxy and trigger a request',
        t('doctor.trafficWarn'));
    }
  } catch (e: any) {
    const message = e && e.message ? String(e.message) : String(e);
    const downPort = daemonDownPort(message);
    add('daemon', 'doctor.name.daemon', 'FAIL', message,
      downPort === null ? message : t('doctor.daemonDown', { port: downPort }));
    add('fix', 'doctor.name.fix', 'WARN', 'run: pbmockx fix', t('doctor.fixHint'));
  }

  try {
    const w2 = execSync('w2 --version', { stdio: 'pipe', timeout: 3000 }).toString().trim();
    add('legacy whistle', 'doctor.name.legacy', 'WARN',
      `${w2} installed — pbmockx no longer uses it; stop it if it occupies port ${port}`,
      t('doctor.legacyInstalled', { version: w2, port }));
  } catch {
    add('legacy whistle', 'doctor.name.legacy', 'OK', 'not installed', t('doctor.legacyAbsent'));
  }

  const skillTargets = [
    path.join(os.homedir(), '.agents/skills/pbmockx'),
    path.join(os.homedir(), '.claude/skills/pbmockx'),
  ];
  for (const dir of skillTargets) {
    const short = dir.replace(os.homedir(), '~');
    try {
      const st = fs.lstatSync(dir);
      if (!st.isSymbolicLink()) {
        add('skill', 'doctor.name.skill', 'WARN',
          short + ' is not a symlink (run: pbmockx skill install)',
          t('doctor.skillNotSymlink', { path: short }));
      } else if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        add('skill', 'doctor.name.skill', 'OK', short + ' -> ' + fs.readlinkSync(dir),
          t('doctor.skillOk', { path: short, target: fs.readlinkSync(dir) }));
      } else {
        add('skill', 'doctor.name.skill', 'WARN', short + ' broken -> ' + fs.readlinkSync(dir),
          t('doctor.skillBroken', { path: short, target: fs.readlinkSync(dir) }));
      }
    } catch {
      add('skill', 'doctor.name.skill', 'WARN', short + ' not installed (run: pbmockx skill install)',
        t('doctor.skillMissing', { path: short }));
    }
  }

  if (args.includes('--json')) {
    const checks = rows.map(({ name, status, detail }) => ({ name, status, detail }));
    console.log(JSON.stringify({ version: readVersion(p), port, checks }, null, 2));
    return;
  }

  console.log('=== pbmockx doctor ===');
  console.log(t('doctor.version', { version: readVersion(p) }));
  for (const r of rows) {
    const tag = r.status === 'OK' ? '[ OK ]' : r.status === 'WARN' ? '[WARN]' : '[FAIL]';
    console.log(t('doctor.row', { tag, label: r.label, detail: r.text }));
  }
  if (rows.some((r) => r.status === 'FAIL')) {
    console.log('\n' + t('doctor.next'));
  }
}

async function cmdFix(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpFix(); return; }
  console.log('=== pbmockx fix ===');
  console.log(t('fix.step1'));
  // `fix` rebuilds from source, which only exists in a git checkout. Installs
  // from npm ship compiled dist/ and no TypeScript sources.
  if (!fs.existsSync(path.join(ROOT, 'tsconfig.json'))) {
    console.error('  ' + t('fix.noSources'));
    console.error('  ' + t('fix.upgrade'));
    process.exit(1);
  }
  try {
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
      console.log('  ' + t('fix.installingDeps'));
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    }
    execSync('npx tsc -p tsconfig.json', { cwd: ROOT, stdio: 'inherit' });
    console.log('  ' + t('fix.buildOk'));
  } catch (e: any) {
    console.error('  ' + t('fix.buildFailed', { message: e.message }));
    process.exit(1);
  }

  console.log(t('fix.step2'));
  const p = paths();
  const rt = (() => { try { return JSON.parse(fs.readFileSync(p.runtimeFile, 'utf-8')); } catch { return null; } })();
  try {
    if (rt) await cmdRestart({ dataDir: p.dataDir, port: rt.port });
    else await cmdStart({ dataDir: p.dataDir });
  } catch (e: any) {
    console.error('  ' + t('fix.restartFailed', { message: e.message }));
    process.exit(1);
  }

  console.log(t('fix.step3'));
  const ok = await waitForHealth(resolvePort(p), 10000, resolveHost(p));
  if (!ok) {
    console.error('  ' + t('fix.notHealthy'));
    try { console.error(fs.readFileSync(p.logFile, 'utf-8').split('\n').slice(-20).join('\n')); } catch {}
    process.exit(1);
  }
  console.log('\n' + t('fix.ok', { flows: ok.flow_count, rules: ok.rules }));
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
      console.error(t('skill.dirMissing', { dir: skillDir }));
      process.exit(1);
    }
    for (const target of targets) {
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
      cleanTarget(target);
      try {
        fs.symlinkSync(skillDir, target);
        console.log(t('skill.installed', { target, source: skillDir }));
      } catch (e: any) {
        console.error(t('skill.failed', { target, message: e.message }));
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
        console.log(st.isSymbolicLink()
          ? t('skill.found', { path: p, target: fs.readlinkSync(p) })
          : t('skill.foundNotSymlink', { path: p }));
      } catch {}
    }
    if (!found) console.log(t('render.none'));
    return;
  }
  if (sub === 'uninstall') {
    for (const p of targets) {
      cleanTarget(p);
      console.log(t('skill.removed', { path: p }));
    }
    return;
  }
  help.helpSkill();
}

async function cmdLang(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpLang(); return; }
  const p = paths();
  const json = args.includes('--json');
  const target = positionals(args.filter((a) => a !== '--json'))[0] || '';
  const configLang = String((readConfigFile(p) as any).lang || '');
  const source = process.env.PBMOCKX_LANG
    ? 'env'
    : configLang
      ? 'config'
      : detectLangFromEnv()
        ? 'system'
        : 'default';

  if (!target) {
    const lang = getLang();
    if (json) {
      console.log(JSON.stringify({ lang, source, config: configLang || null }, null, 2));
      return;
    }
    console.log(t('lang.current', { lang: `${t(('lang.name.' + lang) as MsgKey)} (${lang})` }));
    console.log(t('lang.source', { source: t(('lang.source.' + source) as MsgKey) }));
    console.log(configLang ? t('lang.configLine', { value: configLang }) : t('lang.autoLine'));
    if (source === 'env') console.log(t('lang.envHint', { env: process.env.PBMOCKX_LANG || '' }));
    return;
  }

  if (target === 'auto') {
    patchConfigFile(p, { lang: undefined });
    // Re-resolve from env/system so the confirmation is in the resulting language.
    initLang({});
    console.log(t('lang.cleared'));
  } else {
    const normalized = normalizeLang(target);
    if (!normalized) usageError(t('lang.invalid', { value: target }));
    patchConfigFile(p, { lang: normalized });
    initLang({ explicit: normalized });
    console.log(t('lang.set', { lang: t(('lang.name.' + normalized) as MsgKey), value: normalized }));
  }

  // /health.lang feeds the Web UI default, so a running daemon must reload.
  const rt = readRuntime(p);
  if (rt) {
    console.log(t('lang.restarting'));
    await cmdRestart({ port: rt.port, host: rt.host });
  } else {
    console.log(t('lang.restartHint'));
  }
}

async function cmdVersion(args: string[]): Promise<void> {
  if (hasHelp(args)) { help.helpVersion(); return; }
  const p = paths();
  const ver = readVersion(p);
  console.log(t('cli.version', { version: ver }));
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
      console.log(latest !== ver ? t('version.updateAvailable', { latest }) : t('version.upToDate'));
    }
  } catch (e: any) {
    console.log(t('version.checkFailed', { message: e.message }));
  }
}

// --- dispatcher ---

/**
 * Consume global flags (`--data-dir`, `--lang`) before dispatch so subcommands
 * never see them. Both `--flag value` and `--flag=value` are accepted, and the
 * flags may appear anywhere on the command line.
 */
function stripGlobal(argv: string[]): { argv: string[]; lang?: string } {
  const out: string[] = [];
  let lang: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-dir') {
      if (argv[i + 1]) {
        process.env.PBMOCKX_DATA_DIR = path.resolve(argv[i + 1]);
        i++;
      }
      continue;
    }
    if (arg === '--lang') {
      if (argv[i + 1]) {
        lang = argv[i + 1];
        i++;
      }
      continue;
    }
    if (arg.startsWith('--lang=')) {
      lang = arg.slice('--lang='.length);
      continue;
    }
    out.push(arg);
  }
  return { argv: out, lang };
}

async function dispatch(cmd: string, args: string[]): Promise<void> {
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
    case 'lang': await cmdLang(args); return;

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
      console.error(t('error.unknownCommand', { command: cmd }));
      console.log(t('error.runHelp'));
      process.exit(1);
  }
}

export async function main(argv: string[]): Promise<void> {
  const global = stripGlobal(argv);
  argv = global.argv;
  const langFlag = global.lang;
  // Setting PBMOCKX_LANG also propagates to the daemon spawned by `start`, so
  // the CLI and the daemon (and therefore the Web UI) agree on one language.
  if (langFlag) process.env.PBMOCKX_LANG = normalizeLang(langFlag) || 'en';
  initLang({ explicit: langFlag, config: readConfigFile(paths()) });

  const [cmd, ...args] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    help.helpMain();
    return;
  }

  try {
    await dispatch(cmd, args);
  } catch (e: any) {
    // Only the fixed "daemon not running" message from api.ts is rewritten;
    // every other error keeps the exact previous behaviour (Error: + exit 1).
    const message = e && e.message ? String(e.message) : String(e);
    const downPort = daemonDownPort(message);
    if (downPort !== null) {
      console.error('Error: ' + t('error.daemonDown', { port: downPort }));
      process.exit(1);
    }
    throw e;
  }
}

export { parseValue, ApiClient, health };
