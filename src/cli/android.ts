/**
 * Android helpers: adb proxy configuration + CA certificate status detection.
 *
 * All probe/classify functions are pure so they can be unit-tested without a
 * device. The CA is read from the local pbmockx data directory.
 */

import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as fs from 'fs';

let _forge: any;
function forge(): any {
  if (!_forge) _forge = require('node-forge');
  return _forge;
}

/** Compute OpenSSL subject_hash_old (Android CA filename hash) from PEM. */
export function subjectHashOld(pem: string): string {
  const f = forge();
  const cert = f.pki.certificateFromPem(pem);
  const derBytes = f.asn1.toDer(f.pki.distinguishedNameToAsn1(cert.subject)).getBytes();
  return crypto
    .createHash('md5')
    .update(Buffer.from(derBytes, 'binary'))
    .digest()
    .readUInt32LE(0)
    .toString(16)
    .padStart(8, '0');
}

function adbShell(serial: string | null, cmd: string): { ok: boolean; out?: string; denied?: boolean; missing?: boolean; err?: string } {
  const full = (serial ? 'adb -s ' + serial + ' shell ' : 'adb shell ') + cmd;
  try {
    return { ok: true, out: execSync(full, { stdio: 'pipe' }).toString().trim() };
  } catch (e: any) {
    // adb merges device stdout/stderr into local stdout; both are checked.
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

function isAdbRoot(serial: string | null): boolean {
  const r = adbShell(serial, 'id');
  return !!r.ok && /uid=0/.test(r.out || '');
}

function hasSu(serial: string | null): boolean {
  const r = adbShell(serial, '"su -c id"');
  return !!r.ok && /uid=0/.test(r.out || '');
}

interface CertProbe {
  dir: string;
  found?: boolean;
  denied?: boolean;
  ok?: boolean;
}

/** Detect cert by subject hash on device. state: system|user|not_found|unknown. */
export function detectCert(serial: string | null, hash: string): {
  state: string;
  system: CertProbe[];
  user: CertProbe[];
  root: boolean;
} {
  const sysDirs = ['/apex/com.android.conscrypt/cacerts', '/system/etc/security/cacerts'];
  const usrDir = '/data/misc/user/0/cacerts-added';

  const probe = (dir: string, mode: 'direct' | 'su'): CertProbe => {
    let found = false;
    let denied = false;
    let ok = true;
    for (const idx of [0, 1, 2]) {
      const target = dir + '/' + hash + '.' + idx;
      const cmd = mode === 'su' ? '"su -c \'ls ' + target + '\'"' : 'ls ' + target;
      const r = adbShell(serial, cmd);
      if (r.ok && r.out) { found = true; break; }
      if (r.denied) denied = true;
      if (!r.ok) ok = false;
    }
    return { dir, found, denied, ok };
  };

  const system = sysDirs.map((d) => probe(d, 'direct'));
  const adbRoot = isAdbRoot(serial);
  const suRoot = !adbRoot && hasSu(serial);
  const root = adbRoot || suRoot;
  const user = root
    ? [probe(usrDir, adbRoot ? 'direct' : 'su')]
    : [{ dir: usrDir, found: false, denied: true, ok: true }];

  return { state: classifyCertState(system, user), system, user, root };
}

/** Classify cert state from probe results. Pure function. */
export function classifyCertState(system: CertProbe[], user: CertProbe[]): string {
  const systemFound = system.some((d) => d.found);
  const userFound = user.some((d) => d.found);
  const anyIndeterminate = system.concat(user).some((d) => d.denied || !d.ok);
  if (systemFound) return 'system';
  if (userFound) return 'user';
  if (anyIndeterminate) return 'unknown';
  return 'not_found';
}

/** Classify proxy state from raw adb output. Pure function. */
export function classifyProxyState(raw: string, expected: string): { state: string; raw: string; expected: string } {
  const v = (raw || '').trim();
  if (!v || v === 'null' || v === ':0') return { state: 'unset', raw: v, expected };
  return { state: v === expected ? 'ok' : 'mismatch', raw: v, expected };
}

/** Detect proxy state: ok|unset|mismatch|unknown. */
export function detectProxy(serial: string | null, port: number): { state: string; raw?: string; expected: string } {
  const expected = '127.0.0.1:' + port;
  const r = adbShell(serial, 'settings get global http_proxy');
  if (!r.ok) return { state: 'unknown', raw: r.err, expected };
  return classifyProxyState(r.out || '', expected);
}

/** Parse `adb devices` output → array of {serial,state} (all states included). */
export function parseDevices(out: string): Array<{ serial: string; state: string }> {
  return (out || '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const p = l.split(/\s+/);
      return { serial: p[0], state: p[1] || '' };
    });
}

/** List adb devices. Returns null if adb is unavailable. */
export function listDevices(): Array<{ serial: string; state: string }> | null {
  try {
    return parseDevices(execSync('adb devices', { stdio: 'pipe' }).toString());
  } catch {
    return null;
  }
}

export function readCaPem(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}
