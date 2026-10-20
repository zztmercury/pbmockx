/**
 * Daemon lifecycle commands: start / stop / restart / status / logs / ca.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

import {
  dataDir,
  loadConfig,
  packageRoot,
  paths,
  readRuntime,
  resolvePort,
  readVersion,
  type PbmockxPaths,
} from '../core/config';
import { tailFile } from '../core/logger';
import { CertAuthority } from '../proxy/ca';
import { health } from './api';

export interface StartOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  foreground?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForHealth(port: number, timeoutMs = 15000): Promise<any | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await health(port);
    } catch {
      await sleep(250);
    }
  }
  return null;
}

function statePaths(dir?: string): PbmockxPaths {
  return paths(dir || process.env.PBMOCKX_DATA_DIR || dataDir());
}

export async function cmdStart(opts: StartOptions = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const cfg = loadConfig({}, p);
  const port = opts.port || cfg.port;
  const host = opts.host || cfg.host;

  const existing = await waitForHealth(port, 600);
  if (existing) {
    console.log(`pbmockx is already running at http://127.0.0.1:${port} (pid ${readRuntime(p)?.pid || '?'})`);
    return;
  }

  if (opts.foreground) {
    const { startDaemon } = require('../server/daemon');
    const handle = await startDaemon({ dataDir: p.dataDir, port, host });
    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    console.log(`pbmockx daemon running at http://${host}:${handle.port} (Ctrl+C to stop)`);
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
    },
  });
  child.unref();
  fs.closeSync(logFd);

  const ready = await waitForHealth(port, 20000);
  if (!ready) {
    console.error('pbmockx failed to start. Last log lines:');
    console.error(tailFile(p.logFile, 30));
    process.exitCode = 1;
    return;
  }
  console.log(`pbmockx started (pid ${readRuntime(p)?.pid || child.pid})`);
  console.log(`  proxy : http://${host}:${port}`);
  console.log(`  UI    : http://127.0.0.1:${port}/`);
  console.log(`  data  : ${p.dataDir}`);
  console.log(`  CA    : ${p.caCertFile}`);
  console.log('');
  console.log('Next: install the CA on your device (pbmockx ca), then configure the proxy above.');
}

export async function cmdStop(opts: { dataDir?: string } = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const rt = readRuntime(p);
  if (!rt) {
    console.log('pbmockx is not running');
    return;
  }
  try { process.kill(rt.pid, 'SIGTERM'); } catch (e: any) {
    if (e.code !== 'ESRCH') console.error('stop failed:', e.message);
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
  console.log('pbmockx stopped');
}

export async function cmdRestart(opts: StartOptions = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const rt = readRuntime(p);
  if (rt) {
    await cmdStop({ dataDir: p.dataDir });
    await cmdStart({ ...opts, port: opts.port || rt.port, host: opts.host || rt.host });
  } else {
    await cmdStart(opts);
  }
}

export async function cmdStatus(opts: { dataDir?: string; json?: boolean } = {}): Promise<void> {
  const p = statePaths(opts.dataDir);
  const port = resolvePort(p);
  let info: any = null;
  try { info = await health(port); } catch {}
  const rt = readRuntime(p);
  if (opts.json) {
    console.log(JSON.stringify({ running: !!info, port, runtime: rt, health: info }, null, 2));
    return;
  }
  console.log('pbmockx', readVersion(p));
  if (info) {
    const uptime = Math.round((info.uptime || 0) / 1000);
    console.log(`Daemon: running (pid ${rt?.pid || '?'}) http://127.0.0.1:${port}`);
    console.log(`Uptime: ${formatUptime(uptime)} | flows: ${info.flow_count} | rules: ${info.rules}`);
    console.log(`UI:     http://127.0.0.1:${port}/`);
  } else {
    console.log('Daemon: not running');
    console.log(`Start:  pbmockx start${p.dataDir !== dataDir() ? ` --data-dir ${p.dataDir}` : ''}`);
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
  try { await health(port); running = true; } catch {}

  const ca = new CertAuthority(p.caDir);

  if (opts.regen) {
    if (!opts.yes) {
      console.error('Refusing to regenerate the CA without --yes (all devices will need to re-trust it).');
      process.exitCode = 1;
      return;
    }
    await ca.regenerate();
    console.log('CA regenerated at', p.caCertFile);
    if (running) {
      console.log('Restarting daemon to load the new CA...');
      await cmdRestart({ dataDir: p.dataDir, port });
    }
  } else if (!fs.existsSync(p.caCertFile)) {
    await ca.ensure();
    console.log('Generated CA at', p.caCertFile);
    if (running) console.log('Restart the daemon to load it: pbmockx restart');
  }

  await ca.ensure();
  const info = ca.info();
  if (opts.out) {
    const out = path.resolve(opts.out);
    fs.writeFileSync(out, ca.getCaPem());
    console.log('Wrote CA certificate to', out);
    return;
  }
  if (opts.info) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log('CA certificate:', info.path);
  console.log('Subject      :', info.subject);
  console.log('SHA-256      :', info.fingerprint256);
  console.log('Android hash :', info.subjectHashOld);
  console.log('Valid        :', info.notBefore, '->', info.notAfter);
  console.log('');
  console.log('Install it on the client device:');
  console.log('  download  : http://127.0.0.1:' + port + '/__pbmockx/api/ca.pem');
  console.log('  copy file : pbmockx ca --out ./pbmockx-ca.crt');
  console.log('');
  console.log('macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ./pbmockx-ca.crt');
  console.log('Windows: certutil -addstore -f "ROOT" pbmockx-ca.crt');
  console.log('Linux:   sudo cp pbmockx-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates');
  console.log('Android: pbmockx connect-android   (proxy + cert status; system cert needs root/Magisk)');
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
    console.log('Open manually:', url);
  }
}
