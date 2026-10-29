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
  /** UI/CLI language: "zh" | "en". Unset = follow the system locale (fallback en). */
  lang?: string;
  proxy: {
    mitm: boolean;
    mitmPorts: number[];
    bypass: string[];
    /** Record un-decrypted CONNECT tunnels as metadata-only flows (diagnostics). */
    recordTunnels: boolean;
    upstreamTLS: { rejectUnauthorized: boolean };
  };
  capture: {
    maxFlows: number;
    maxRecordBodyBytes: number;
    maxTotalRecordBytes: number;
    maxRewriteBodyBytes: number;
  };
  ui: {
    /** Allow the control API + Web UI from non-loopback clients (LAN). */
    lanAccess: boolean;
    [key: string]: unknown;
  };
}

export const DEFAULT_CONFIG: PbmockxConfig = {
  port: 8899,
  host: '127.0.0.1',
  proxy: {
    mitm: true,
    mitmPorts: [443, 8443],
    bypass: [],
    recordTunnels: true,
    upstreamTLS: { rejectUnauthorized: true },
  },
  capture: {
    maxFlows: 500,
    maxRecordBodyBytes: 4 * 1024 * 1024,
    maxTotalRecordBytes: 256 * 1024 * 1024,
    maxRewriteBodyBytes: 64 * 1024 * 1024,
  },
  ui: {
    // Binding 127.0.0.1 already limits reachability; when the daemon is
    // explicitly bound to 0.0.0.0 we allow the UI from the LAN too (set
    // ui.lanAccess=false to expose the proxy only).
    lanAccess: true,
  },
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
  if (process.env.PBMOCKX_LAN === '0') cfg.ui.lanAccess = false;
  if (process.env.PBMOCKX_LAN === '1') cfg.ui.lanAccess = true;
  cfg = merge(cfg, overrides);
  cfg.port = Number(cfg.port) || DEFAULT_CONFIG.port;
  if (!Array.isArray(cfg.proxy.bypass)) cfg.proxy.bypass = [];
  if (!Array.isArray(cfg.proxy.mitmPorts)) cfg.proxy.mitmPorts = DEFAULT_CONFIG.proxy.mitmPorts;
  if (cfg.proxy.recordTunnels === undefined) cfg.proxy.recordTunnels = true;
  return cfg;
}

export function writeConfig(p: PbmockxPaths, cfg: PbmockxConfig): void {
  fs.mkdirSync(path.dirname(p.configFile), { recursive: true });
  const tmp = p.configFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, p.configFile);
}

/**
 * Shallow-patch config.json in place: set keys, or delete them by passing
 * `undefined`. Unlike writeConfig() this never materialises defaults, so
 * `pbmockx lang zh` only adds `"lang": "zh"` to the file.
 */
export function patchConfigFile(p: PbmockxPaths, patch: Record<string, unknown>): void {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p.configFile, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = {};
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  fs.mkdirSync(path.dirname(p.configFile), { recursive: true });
  const tmp = p.configFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
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

/** Host used by the CLI to reach the daemon (runtime host unless wildcard). */
export function resolveHost(p: PbmockxPaths = paths()): string {
  const rt = readRuntime(p);
  if (rt && rt.host && rt.host !== '0.0.0.0' && rt.host !== '::') return rt.host;
  return '127.0.0.1';
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

/** Non-internal IPv4 addresses, private ranges first (best LAN candidates). */
export function localAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      const family: any = (a as any).family;
      if ((family === 'IPv4' || family === 4) && !a.internal) out.push(a.address);
    }
  }
  const score = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return [...new Set(out)].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/**
 * Whether a Host header / URL hostname refers to this machine. Used to decide
 * between the local UI/API and proxy traffic on the shared port.
 */
export function isLocalHostname(host: string, addresses: string[] = localAddresses()): boolean {
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.startsWith('127.')) return true;
  if (addresses.includes(h)) return true;
  const hostname = os.hostname().toLowerCase();
  return h === hostname || h === hostname + '.local';
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.');
}
