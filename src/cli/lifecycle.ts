/**
 * Daemon lifecycle commands: start / stop / restart / status / logs / ca.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

import {
  dataDir,
  loadConfig,
  localAddresses,
  packageRoot,
  paths,
  readRuntime,
  resolveHost,
  resolvePort,
  readVersion,
  type PbmockxPaths,
} from '../core/config';
import { tailFile } from '../core/logger';
import { t } from '../i18n';
import { CertAuthority } from '../proxy/ca';
import { health } from './api';

export interface StartOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  foreground?: boolean;
  /** Bind 0.0.0.0 and allow UI/API access from the LAN. */
  lan?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForHealth(port: number, timeoutMs = 15000, host = '127.0.0.1'): Promise<any | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await health(port, host);
    } catch {
      await sleep(250);
    }
  }
  return null;
}

function wildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

function probeHostFor(host: string): string {
  return wildcardHost(host) ? '127.0.0.1' : host;
}

function statePaths(dir?: string): PbmockxPaths {
  return paths(dir || process.env.PBMOCKX_DATA_DIR || dataDir());
}

export async function cmdStart(opts: StartOptions = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const cfg = loadConfig({}, p);
  const port = opts.port || cfg.port;
  const host = opts.host || (opts.lan ? '0.0.0.0' : cfg.host);

  // If an instance is already running, report its real host/port instead of
  // starting a second one on a possibly different interface.
  const existingRuntime = readRuntime(p);
  if (existingRuntime) {
    const existing = await waitForHealth(existingRuntime.port, 600, probeHostFor(existingRuntime.host));
    if (existing) {
      console.log(t('start.alreadyRunning', {
        host: probeHostFor(existingRuntime.host),
        port: existingRuntime.port,
        pid: existingRuntime.pid || '?',
      }));
      const ips = localAddresses();
      if (wildcardHost(existingRuntime.host) && ips.length) {
        console.log(t('start.lanLine', { ip: ips[0], port: existingRuntime.port }));
      }
      return;
    }
  }

  if (opts.foreground) {
    const { startDaemon } = require('../server/daemon');
    const handle = await startDaemon({
      dataDir: p.dataDir,
      port,
      host,
      config: opts.lan ? { ui: { lanAccess: true } } : undefined,
    });
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    const shown = probeHostFor(host);
    console.log(t('start.foreground', { host: shown, port: handle.port }));
    return;
  }

  fs.mkdirSync(p.logDir, { recursive: true });
  const logFd = fs.openSync(p.logFile, 'a');
  const child = spawn(process.execPath, [path.join(packageRoot(), 'bin', 'pbmockxd.js')], {
    cwd: packageRoot(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PBMOCKX_DATA_DIR: p.dataDir,
      PBMOCKX_PORT: String(port),
      PBMOCKX_HOST: host,
      ...(opts.lan ? { PBMOCKX_LAN: '1' } : {}),
    },
  });
  child.unref();
  fs.closeSync(logFd);

  const ready = await waitForHealth(port, 20000, probeHostFor(host));
  if (!ready) {
    console.error(t('start.failed'));
    console.error(tailFile(p.logFile, 30));
    process.exitCode = 1;
    return;
  }
  const shownHost = probeHostFor(host);
  console.log(t('start.started', { pid: readRuntime(p)?.pid || child.pid }));
  console.log(t('start.proxyLine', { host, port }));
  console.log(t('start.uiLine', { host: shownHost, port }));
  const ips = localAddresses();
  if ((host === '0.0.0.0' || host === '::') && ips.length) {
    for (const ip of ips.slice(0, 3)) console.log(t('start.lanAddress', { ip, port }));
    console.log('');
    console.log(t('start.lanNote1'));
    console.log(t('start.lanNote2'));
  } else if (host === '0.0.0.0' || host === '::') {
    console.log(t('start.noLanIp'));
  }
  console.log(t('start.dataLine', { dir: p.dataDir }));
  console.log(t('start.caLine', { file: p.caCertFile }));
  console.log('');
  console.log(t('start.next'));
}

export async function cmdStop(opts: { dataDir?: string } = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const rt = readRuntime(p);
  if (!rt) {
    console.log(t('stop.notRunning'));
    return;
  }
  try { process.kill(rt.pid, 'SIGTERM'); } catch (e: any) {
    if (e.code !== 'ESRCH') console.error(t('stop.failed', { message: e.message }));
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(200);
    let alive = true;
    try { process.kill(rt.pid, 0); } catch { alive = false; }
    if (!alive) break;
  }
  try { process.kill(rt.pid, 0); process.kill(rt.pid, 'SIGKILL'); } catch {}
  try { fs.unlinkSync(p.runtimeFile); } catch {}
  console.log(t('stop.stopped'));
}

export async function cmdRestart(opts: StartOptions = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const rt = readRuntime(p);
  if (rt) {
    await cmdStop({ dataDir: p.dataDir });
    await cmdStart({
      ...opts,
      port: opts.port || rt.port,
      host: opts.host || (opts.lan ? '0.0.0.0' : rt.host),
    });
  } else {
    await cmdStart(opts);
  }
}

export async function cmdStatus(opts: { dataDir?: string; json?: boolean } = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const port = resolvePort(p);
  let info: any = null;
  try { info = await health(port, resolveHost(p)); } catch {}
  const rt = readRuntime(p);
  const ips = localAddresses();
  const lanHost = rt && (rt.host === '0.0.0.0' || rt.host === '::') ? ips[0] : undefined;
  if (opts.json) {
    console.log(JSON.stringify({ running: !!info, port, runtime: rt, health: info, lanAddresses: ips }, null, 2));
    return;
  }
  console.log(t('cli.version', { version: readVersion(p) }));
  if (info) {
    const uptime = Math.round((info.uptime || 0) / 1000);
    const shownHost = rt && !wildcardHost(rt.host) ? rt.host : '127.0.0.1';
    console.log(t('status.daemonRunning', { pid: rt?.pid || '?', host: shownHost, port }));
    console.log(t('status.uptime', { uptime: formatUptime(uptime), flows: info.flow_count, rules: info.rules }));
    console.log(t('status.ui', { host: shownHost, port }));
    if (lanHost) console.log(t('status.lan', { ip: lanHost, port }));
  } else {
    console.log(t('status.notRunning'));
    console.log(t('status.start', { dataDir: p.dataDir !== dataDir() ? ` --data-dir ${p.dataDir}` : '' }));
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm ' + (seconds % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

export async function cmdLogs(opts: { dataDir?: string; follow?: boolean; lines?: number } = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const n = opts.lines || 80;
  console.log(tailFile(p.logFile, n));
  if (!opts.follow) return;

  let offset = 0;
  try { offset = fs.statSync(p.logFile).size; } catch {}
  const timer = setInterval(() => {
    try {
      const st = fs.statSync(p.logFile);
      if (st.size <= offset) {
        if (st.size < offset) offset = 0;
        return;
      }
      const fd = fs.openSync(p.logFile, 'r');
      const buf = Buffer.alloc(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = st.size;
      process.stdout.write(buf);
    } catch {}
  }, 500);
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { clearInterval(timer); resolve(); });
    process.on('SIGTERM', () => { clearInterval(timer); resolve(); });
  });
}

export async function cmdCa(opts: {
  dataDir?: string;
  out?: string;
  info?: boolean;
  regen?: boolean;
  yes?: boolean;
} = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const port = resolvePort(p);
  let running = false;
  try { await health(port, resolveHost(p)); running = true; } catch {}

  const ca = new CertAuthority(p.caDir);

  if (opts.regen) {
    if (!opts.yes) {
      console.error(t('ca.regenNeedsYes'));
      process.exitCode = 1;
      return;
    }
    await ca.regenerate();
    console.log(t('ca.regenerated', { file: p.caCertFile }));
    if (running) {
      console.log(t('ca.restarting'));
      await cmdRestart({ dataDir: p.dataDir, port });
    }
  } else if (!fs.existsSync(p.caCertFile)) {
    await ca.ensure();
    console.log(t('ca.generated', { file: p.caCertFile }));
    if (running) console.log(t('ca.restartToLoad'));
  }

  await ca.ensure();
  const info = ca.info();
  if (opts.out) {
    const out = path.resolve(opts.out);
    fs.writeFileSync(out, ca.getCaPem());
    console.log(t('ca.wrote', { file: out }));
    return;
  }
  if (opts.info) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(t('ca.certificate', { file: info.path }));
  console.log(t('ca.subject', { subject: info.subject }));
  console.log(t('ca.sha256', { fingerprint: info.fingerprint256 }));
  console.log(t('ca.androidHash', { hash: info.subjectHashOld }));
  console.log(t('ca.valid', { notBefore: info.notBefore, notAfter: info.notAfter }));
  console.log('');
  console.log(t('ca.installTitle'));
  console.log(t('ca.download', { port }));
  console.log(t('ca.copyFile'));
  console.log('');
  console.log('macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ./pbmockx-ca.crt');
  console.log('Windows: certutil -addstore -f "ROOT" pbmockx-ca.crt');
  console.log('Linux:   sudo cp pbmockx-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates');
  console.log(t('ca.android'));
}

export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin'
    ? `open "${url}"`
    : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch {
    console.log(t('web.openManual', { url }));
  }
}
