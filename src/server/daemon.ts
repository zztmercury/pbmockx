/**
 * pbmockxd — the capture daemon.
 *
 * One HTTP listener serves both the forward proxy (absolute-form requests,
 * CONNECT, WebSocket upgrades) and the local control API + Web UI (loopback
 * origin-form requests). This mirrors whistle's single-port UX.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {
  clearRuntime,
  ensureDirs,
  isLoopbackAddress,
  loadConfig,
  packageRoot,
  paths,
  readVersion,
  writeRuntime,
  type PbmockxConfig,
  type PbmockxPaths,
} from '../core/config';
import { log, setLogFile } from '../core/logger';
import { FlowStore } from '../core/flow-store';
import { RuleEngine } from '../core/rules';
import { DescCache, PBEngine } from '../core/pb-engine';
import { MockEngine } from '../mock/engine';
import { CertAuthority } from '../proxy/ca';
import { ProxyEngine } from '../proxy/proxy';
import { EventHub } from './events';
import { createApiHandler } from './control-api';
import { serveStatic } from './static';

export interface DaemonOptions {
  dataDir?: string;
  config?: Partial<PbmockxConfig>;
  port?: number;
  host?: string;
}

export interface DaemonHandle {
  server: http.Server;
  port: number;
  host: string;
  config: PbmockxConfig;
  paths: PbmockxPaths;
  close: () => Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function isLocalRequest(req: http.IncomingMessage, config: PbmockxConfig): boolean {
  const raw = req.url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      return isLoopbackHost(u.hostname) && port === config.port;
    } catch {
      return false;
    }
  }
  const host = req.headers.host || '';
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  const hostname = m ? m[1] : host;
  const port = m && m[2] ? Number(m[2]) : 80;
  return isLoopbackHost(hostname) && port === config.port;
}

function importLegacyState(p: PbmockxPaths): void {
  if (fs.existsSync(p.rulesFile)) return;
  const root = packageRoot();
  const candidates = [
    process.env.PBMOCKX_LEGACY_RULES,
    path.join(root, 'whistle-plugin', 'rules.yaml'),
    path.join(root, 'rules.yaml'),
    path.join(root, '..', 'whistle-plugin', 'rules.yaml'),
    path.join(root, '..', '..', 'whistle-plugin', 'rules.yaml'),
  ].filter(Boolean) as string[];
  for (const src of candidates) {
    try {
      if (!fs.existsSync(src) || path.resolve(src) === path.resolve(p.rulesFile)) continue;
      fs.mkdirSync(p.dataDir, { recursive: true });
      fs.copyFileSync(src, p.rulesFile);
      const legacyMock = path.join(path.dirname(src), 'mock-data');
      if (fs.existsSync(legacyMock) && fs.statSync(legacyMock).isDirectory()) {
        fs.mkdirSync(p.mockDataDir, { recursive: true });
        for (const f of fs.readdirSync(legacyMock)) {
          const dst = path.join(p.mockDataDir, f);
          if (!fs.existsSync(dst)) {
            try { fs.copyFileSync(path.join(legacyMock, f), dst); } catch {}
          }
        }
      }
      log.info(`imported legacy rules from ${src}`);
      return;
    } catch (e: any) {
      log.warn('legacy import failed:', src, e.message);
    }
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const p = paths(opts.dataDir);
  ensureDirs(p);
  setLogFile(p.logFile);

  const overrides: Partial<PbmockxConfig> = { ...(opts.config || {}) };
  if (opts.port !== undefined) overrides.port = opts.port;
  if (opts.host !== undefined) overrides.host = opts.host;
  const config = loadConfig(overrides, p);

  // Only auto-import old whistle rules for the real default data directory.
  // Tests, PBMOCKX_DATA_DIR overrides and explicit --data-dir runs must start
  // from a clean slate.
  const defaultDataDir = path.join(require('os').homedir(), '.pbmockx');
  if (!opts.dataDir && !process.env.PBMOCKX_DATA_DIR && path.resolve(p.dataDir) === path.resolve(defaultDataDir)) {
    importLegacyState(p);
  }

  const ca = new CertAuthority(p.caDir);
  await ca.ensure();

  const rules = new RuleEngine(p.rulesFile, p.mockDataDir);
  const ruleCount = rules.reload();

  const pbEngine = new PBEngine(new DescCache(p.descCacheDir));
  const flowStore = new FlowStore(config.capture.maxFlows, config.capture.maxTotalRecordBytes);
  const mock = new MockEngine(rules, pbEngine, p.mockDataDir);
  const events = new EventHub();
  const startedAt = Date.now();

  const api = createApiHandler({
    config,
    paths: p,
    ca,
    rules,
    pbEngine,
    flowStore,
    events,
    startedAt,
    mockDataDir: p.mockDataDir,
  });

  const proxy = new ProxyEngine({ config, ca, flowStore, mock, events });

  const server = http.createServer((req, res) => {
    if (isLocalRequest(req, config)) {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('pbmockx: management API and UI are loopback-only\n');
        return;
      }
      api(req, res)
        .then((handled) => {
          if (!handled) serveStatic(req, res, p.uiDir);
        })
        .catch((e: any) => {
          log.error('local handler failed:', e && e.stack ? e.stack : e);
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          try { res.end('pbmockx: ' + e.message); } catch {}
        });
      return;
    }
    proxy.handleRequest(req, res, 'http');
  });

  server.on('connect', (req, socket, head) => proxy.handleConnect(req, socket, head));
  server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head, 'http'));
  server.on('clientError', (err, socket: any) => {
    log.debug('clientError:', err.message);
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });
  server.keepAliveTimeout = 65000;

  await new Promise<void>((resolve, reject) => {
    const onError = (e: any) => {
      server.removeListener('listening', onListening);
      if (e && e.code === 'EADDRINUSE') {
        reject(new Error(`port ${config.port} is already in use. Stop the other process or use PBMOCKX_PORT=<port> pbmockx start`));
      } else {
        reject(e);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const addr = server.address() as any;
  if (addr && typeof addr === 'object') config.port = addr.port;

  const version = readVersion(p);
  writeRuntime(p, {
    pid: process.pid,
    port: config.port,
    host: config.host,
    version,
    startedAt,
    dataDir: p.dataDir,
  });

  log.info(
    `pbmockxd v${version} listening on ${config.host}:${config.port} ` +
    `(proxy + UI) | ${flowStore.size()} flows | ${ruleCount} rules | data ${p.dataDir}`
  );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { proxy.close(); } catch {}
    try { events.close(); } catch {}
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
        (server as any).closeAllConnections?.();
        setTimeout(resolve, 1500).unref?.();
      } catch {
        resolve();
      }
    });
    clearRuntime(p);
    log.info('pbmockxd stopped');
  };

  return { server, port: config.port, host: config.host, config, paths: p, close };
}

export async function main(): Promise<void> {
  if (process.stdout.isTTY) process.env.PBMOCKX_LOG_STDERR = '1';
  const handle = await startDaemon({});
  const shutdown = async (sig: string) => {
    log.info('received', sig, '- shutting down');
    try { await handle.close(); } catch (e: any) { log.error('shutdown failed:', e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (e: any) => {
    log.error('uncaughtException:', e && e.stack ? e.stack : e);
  });
  process.on('unhandledRejection', (e: any) => {
    log.error('unhandledRejection:', e && e.stack ? e.stack : e);
  });
}
