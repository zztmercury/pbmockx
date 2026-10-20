/**
 * Config + path resolution for pbmockx.
 *
 * Data directory (default ~/.pbmockx, override PBMOCKX_DATA_DIR):
 *   config.json runtime.json rules.yaml mock-data/ ca/ desc-cache/ logs/
 *
 * Port resolution order (CLI): PBMOCKX_PORT > runtime.json > config.json >
 * WHISTLE_PORT (legacy) > 8899.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PbmockxConfig {
  port: number;
  host: string;
  proxy: {
    mitm: boolean;
    mitmPorts: number[];
    bypass: string[];
    upstreamTLS: { rejectUnauthorized: boolean };
  };
  capture: {
    maxFlows: number;
    maxRecordBodyBytes: number;
    maxTotalRecordBytes: number;
    maxRewriteBodyBytes: number;
  };
  ui: Record<string, unknown>;
}

export const DEFAULT_CONFIG: PbmockxConfig = {
  port: 8899,
  host: '127.0.0.1',
  proxy: {
    mitm: true,
    mitmPorts: [443, 8443],
    bypass: [],
    upstreamTLS: { rejectUnauthorized: true },
  },
  capture: {
    maxFlows: 500,
    maxRecordBodyBytes: 4 * 1024 * 1024,
    maxTotalRecordBytes: 256 * 1024 * 1024,
    maxRewriteBodyBytes: 64 * 1024 * 1024,
  },
  ui: {},
};

/** Package root (contains package.json + VERSION). Works from dist/src/... or src/. */
export function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'VERSION'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..');
}

export function dataDir(): string {
  return path.resolve(
    process.env.PBMOCKX_DATA_DIR || path.join(os.homedir(), '.pbmockx')
  );
}

export interface PbmockxPaths {
  root: string;
  dataDir: string;
  configFile: string;
  runtimeFile: string;
  pidFile: string;
  rulesFile: string;
  mockDataDir: string;
  caDir: string;
  caCertFile: string;
  caKeyFile: string;
  leafKeyFile: string;
  descCacheDir: string;
  logDir: string;
  logFile: string;
  uiDir: string;
  skillFile: string;
  versionFile: string;
}

export function paths(dir?: string): PbmockxPaths {
  const root = packageRoot();
  const d = dir ? path.resolve(dir) : dataDir();
  return {
    root,
    dataDir: d,
    configFile: path.join(d, 'config.json'),
    runtimeFile: path.join(d, 'runtime.json'),
    pidFile: path.join(d, 'pbmockxd.pid'),
    rulesFile: path.join(d, 'rules.yaml'),
    mockDataDir: path.join(d, 'mock-data'),
    caDir: path.join(d, 'ca'),
    caCertFile: path.join(d, 'ca', 'ca.pem'),
    caKeyFile: path.join(d, 'ca', 'ca.key'),
    leafKeyFile: path.join(d, 'ca', 'leaf.key'),
    descCacheDir: path.join(d, 'desc-cache'),
    logDir: path.join(d, 'logs'),
    logFile: path.join(d, 'logs', 'pbmockxd.log'),
    uiDir: path.join(root, 'web'),
    skillFile: path.join(root, 'skill', 'SKILL.md'),
    versionFile: path.join(root, 'VERSION'),
  };
}

export function ensureDirs(p: PbmockxPaths): void {
  for (const d of [p.dataDir, p.mockDataDir, p.caDir, p.descCacheDir, p.logDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function merge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out: any = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = merge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function readConfigFile(p: PbmockxPaths): Partial<PbmockxConfig> {
  try {
    return JSON.parse(fs.readFileSync(p.configFile, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/**
 * Resolve effective config. Precedence: explicit overrides > env > config.json
 * > defaults.
 */
export function loadConfig(overrides: Partial<PbmockxConfig> = {}, p: PbmockxPaths = paths()): PbmockxConfig {
  let cfg = merge(DEFAULT_CONFIG, readConfigFile(p));
  const portEnv = process.env.PBMOCKX_PORT;
  const hostEnv = process.env.PBMOCKX_HOST;
  if (portEnv) cfg.port = parseInt(portEnv, 10) || cfg.port;
  if (hostEnv) cfg.host = hostEnv;
  cfg = merge(cfg, overrides);
  cfg.port = Number(cfg.port) || DEFAULT_CONFIG.port;
  if (!Array.isArray(cfg.proxy.bypass)) cfg.proxy.bypass = [];
  if (!Array.isArray(cfg.proxy.mitmPorts)) cfg.proxy.mitmPorts = DEFAULT_CONFIG.proxy.mitmPorts;
  return cfg;
}

export function writeConfig(p: PbmockxPaths, cfg: PbmockxConfig): void {
  fs.mkdirSync(path.dirname(p.configFile), { recursive: true });
  const tmp = p.configFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, p.configFile);
}

export interface RuntimeInfo {
  pid: number;
  port: number;
  host: string;
  version: string;
  startedAt: number;
  dataDir: string;
}

export function readRuntime(p: PbmockxPaths = paths()): RuntimeInfo | null {
  try {
    const r = JSON.parse(fs.readFileSync(p.runtimeFile, 'utf-8'));
    if (r && typeof r.port === 'number') return r;
    return null;
  } catch {
    return null;
  }
}

export function writeRuntime(p: PbmockxPaths, info: RuntimeInfo): void {
  fs.mkdirSync(p.dataDir, { recursive: true });
  const tmp = p.runtimeFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n');
  fs.renameSync(tmp, p.runtimeFile);
}

export function clearRuntime(p: PbmockxPaths = paths()): void {
  try { fs.unlinkSync(p.runtimeFile); } catch {}
}

/** Port used by the CLI to reach the daemon. */
export function resolvePort(p: PbmockxPaths = paths()): number {
  if (process.env.PBMOCKX_PORT) {
    const n = parseInt(process.env.PBMOCKX_PORT, 10);
    if (n) return n;
  }
  const rt = readRuntime(p);
  if (rt) return rt.port;
  const cfg = loadConfig({}, p);
  if (cfg.port) return cfg.port;
  if (process.env.WHISTLE_PORT) {
    const n = parseInt(process.env.WHISTLE_PORT, 10);
    if (n) return n;
  }
  return DEFAULT_CONFIG.port;
}

export function readVersion(p: PbmockxPaths = paths()): string {
  try { return fs.readFileSync(p.versionFile, 'utf-8').trim(); } catch { return 'unknown'; }
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.');
}
