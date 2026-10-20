/**
 * DescCache — download FileDescriptorSet (.desc binary) with HTTP 1.1
 * conditional request caching (ETag / Last-Modified) + a TTL so the
 * multi-MB .desc is not re-fetched on every request.
 *
 * get() flow:
 *   - within TTL (default 300s) → return cached bytes, zero network
 *   - TTL expired → conditional request (If-None-Match / If-Modified-Since)
 *       - 304 → refresh ts, reuse bytes, changed=false
 *       - 200 → update bytes, changed=true (unless bytes identical)
 *   - network failure → fall back to stale bytes, changed=false (do NOT
 *     refresh ts, so the next call retries the network)
 *
 * Bytes are also persisted on disk so a restarted process still has a
 * last-modified/etag baseline + stale fallback, avoiding a cold 2MB download.
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface CacheEntry {
  etag?: string;
  lastModified?: string;
  bytes: Buffer;
  ts: number;
}

export interface DescResult {
  bytes: Buffer;
  /** true when the server returned new bytes different from the cached ones. */
  changed: boolean;
}

const DEFAULT_TTL_MS = 300 * 1000; // 300s

export class DescCache {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<DescResult>>();
  private cacheDir: string | null;
  private ttlMs: number;

  constructor(cacheDir?: string, ttlMs?: number) {
    this.cacheDir = cacheDir || null;
    this.ttlMs = ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  }

  async get(url: string): Promise<DescResult> {
    const now = Date.now();

    // freshest known entry: memory first, then disk
    let entry = this.cache.get(url);
    if (!entry) {
      entry = this._loadDisk(url);
      if (entry) this.cache.set(url, entry);
    }

    // Within TTL → zero network
    if (entry && now - entry.ts < this.ttlMs) {
      return { bytes: entry.bytes, changed: false };
    }

    // TTL expired (or no entry): dedupe concurrent refreshes of the same URL.
    // Without this, N simultaneous requests all fire a conditional HTTP request
    // the instant the TTL lapses (thundering herd), and each rebuilds the root.
    const existing = this.inflight.get(url);
    if (existing) return existing;

    const p = this._refresh(url, entry);
    this.inflight.set(url, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(url);
    }
  }

  /** Conditional (or fresh) network fetch with stale-fallback semantics. */
  private async _refresh(url: string, entry: CacheEntry | null): Promise<DescResult> {
    const now = Date.now();

    const headers: Record<string, string> = {};
    if (entry) {
      if (entry.etag) headers['If-None-Match'] = entry.etag;
      if (entry.lastModified) headers['If-Modified-Since'] = entry.lastModified;
    }

    try {
      const res = await this._fetch(url, headers);
      if (res.statusCode === 304 && entry) {
        entry.ts = now;
        this.cache.set(url, entry);
        this._saveDisk(url, entry);
        return { bytes: entry.bytes, changed: false };
      }
      if (res.statusCode !== 200) {
        if (entry) { this.cache.set(url, entry); return { bytes: entry.bytes, changed: false }; }
        throw new Error(`desc ${url} HTTP ${res.statusCode}`);
      }
      const bytes = await this._readBody(res);
      const changed = !entry || !bytes.equals(entry.bytes);
      const fresh: CacheEntry = {
        etag: res.headers.etag as string | undefined,
        lastModified: res.headers['last-modified'] as string | undefined,
        bytes,
        ts: now,
      };
      this.cache.set(url, fresh);
      if (changed) this._saveDisk(url, fresh);
      return { bytes, changed };
    } catch (e: any) {
      if (e.code === '304' && entry) return { bytes: entry.bytes, changed: false };
      // Network failure: fall back to stale bytes. changed=false so the caller
      // keeps the existing compiled Root. Do NOT refresh ts → retry next call.
      if (entry) { this.cache.set(url, entry); return { bytes: entry.bytes, changed: false }; }
      throw e;
    }
  }

  private _hash(url: string): string {
    return crypto.createHash('md5').update(url).digest('hex');
  }

  private _diskPath(url: string): { bin: string; idx: string } | null {
    if (!this.cacheDir) return null;
    const hash = this._hash(url);
    return { bin: path.join(this.cacheDir, hash + '.bin'), idx: path.join(this.cacheDir, 'index.json') };
  }

  private _loadDisk(url: string): CacheEntry | null {
    const p = this._diskPath(url);
    if (!p) return null;
    try {
      if (!fs.existsSync(p.bin)) return null;
      const meta = this._readIndex(p.idx);
      const m = meta[this._hash(url)];
      if (!m) return null;
      const bytes = fs.readFileSync(p.bin);
      return { etag: m.etag, lastModified: m.lastModified, bytes, ts: m.ts || 0 };
    } catch {
      return null;
    }
  }

  private _saveDisk(url: string, entry: CacheEntry): void {
    const p = this._diskPath(url);
    if (!p) return;
    try {
      if (!fs.existsSync(this.cacheDir!)) fs.mkdirSync(this.cacheDir!, { recursive: true });
      fs.writeFileSync(p.bin, entry.bytes);
      const meta = this._readIndex(p.idx);
      meta[this._hash(url)] = { etag: entry.etag, lastModified: entry.lastModified, ts: entry.ts };
      fs.writeFileSync(p.idx, JSON.stringify(meta));
    } catch {
      // disk cache is best-effort; ignore write failures
    }
  }

  private _readIndex(idxPath: string): Record<string, { etag?: string; lastModified?: string; ts?: number }> {
    try {
      if (fs.existsSync(idxPath)) {
        const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    return {};
  }

  private _fetch(url: string, headers: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, { method: 'GET', headers, timeout: 10000 }, resolve);
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  private _readBody(res: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  }
}
