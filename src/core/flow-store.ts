/**
 * FlowStore — in-memory LRU store of captured requests.
 *
 * One record holds BOTH request and response data (same id). Eviction is
 * bounded by count AND by total recorded body bytes so a burst of large
 * responses cannot exhaust memory.
 */

import type { DetectInfo } from './content-type';

export type RulePhase = 'request' | 'response';
export type RuleOutcome = 'applied' | 'skipped' | 'error';

export interface MatchedRule {
  id: string;
  type: string;
  phase: RulePhase;
  outcome: RuleOutcome;
  detail?: string;
}

export interface FlowTimings {
  start: number;
  upstreamStart?: number;
  firstByte?: number;
  end?: number;
}

export interface FlowRecord {
  id: string;
  rev: number;
  ts: number;
  url: string;
  originalUrl?: string;
  method: string;
  scheme: string;
  host: string;
  path: string;
  clientIp?: string;
  httpVersion?: string;
  status: number | null;
  statusText?: string;

  reqHeaders?: Record<string, any>;
  resHeaders?: Record<string, any>;
  reqBody?: Buffer | null;
  resBody?: Buffer | null;
  resOriginalBody?: Buffer | null;
  reqContentEncoding?: string;
  resContentEncoding?: string;
  reqInfo?: DetectInfo;
  resInfo?: DetectInfo;

  reqTruncated?: boolean;
  resTruncated?: boolean;
  reqSize?: number;
  resSize?: number;
  resPatched?: boolean;

  durationMs?: number;
  timings?: FlowTimings;
  matchedRules?: MatchedRule[];
  mocked?: boolean;
  patchError?: string;
  decodeError?: string;
  upgrade?: string;
  wsBytesUp?: number;
  wsBytesDown?: number;
  aborted?: boolean;
  error?: string;
  hasReq?: boolean;
  hasRes?: boolean;
}

const BODY_FIELDS: (keyof FlowRecord)[] = ['reqBody', 'resBody', 'resOriginalBody'];

export class FlowStore {
  private store = new Map<string, FlowRecord>();
  private order: string[] = [];
  private totalBytes = 0;
  private maxFlows: number;
  private maxTotalBytes: number;

  constructor(maxFlows = 500, maxTotalBytes = 256 * 1024 * 1024) {
    this.maxFlows = maxFlows;
    this.maxTotalBytes = maxTotalBytes;
  }

  private bodyBytes(rec: FlowRecord): number {
    let n = 0;
    for (const f of BODY_FIELDS) {
      const v = rec[f] as any;
      if (Buffer.isBuffer(v)) n += v.length;
    }
    return n;
  }

  /** Insert or merge a patch into the record. Returns the record. */
  upsert(id: string, patch: Partial<FlowRecord>): FlowRecord {
    let rec = this.store.get(id);
    if (!rec) {
      rec = {
        id,
        rev: 0,
        ts: patch.ts || Date.now(),
        url: patch.url || '',
        method: patch.method || '',
        scheme: patch.scheme || '',
        host: patch.host || '',
        path: patch.path || '',
        status: null,
        hasReq: false,
        hasRes: false,
      } as FlowRecord;
      this.store.set(id, rec);
      this.order.push(id);
    } else {
      this.totalBytes -= this.bodyBytes(rec);
    }

    Object.assign(rec, patch);
    rec.rev = (rec.rev || 0) + 1;

    if (
      patch.reqBody !== undefined || patch.reqHeaders !== undefined ||
      patch.reqInfo !== undefined || patch.reqSize !== undefined
    ) rec.hasReq = true;
    if (
      patch.resBody !== undefined || patch.resHeaders !== undefined ||
      patch.resInfo !== undefined || (patch.status !== undefined && patch.status !== null)
    ) rec.hasRes = true;

    this.totalBytes += this.bodyBytes(rec);
    this.evict();
    return rec;
  }

  private evict(): void {
    while (this.order.length > this.maxFlows || this.totalBytes > this.maxTotalBytes) {
      const old = this.order.shift();
      if (!old) break;
      const rec = this.store.get(old);
      if (rec) {
        this.totalBytes -= this.bodyBytes(rec);
        this.store.delete(old);
      }
      if (this.order.length === 0) break;
    }
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  find(idOrPrefix: string): FlowRecord | null {
    const exact = this.store.get(idOrPrefix);
    if (exact) return exact;
    // Newest first for prefix matching.
    for (let i = this.order.length - 1; i >= 0; i--) {
      const k = this.order[i];
      if (k.startsWith(idOrPrefix)) return this.store.get(k) || null;
    }
    return null;
  }

  list(filterRe?: RegExp, limit?: number): FlowRecord[] {
    const items: FlowRecord[] = [];
    for (let i = this.order.length - 1; i >= 0; i--) {
      const r = this.store.get(this.order[i]);
      if (!r) continue;
      if (filterRe && !filterRe.test(r.url)) continue;
      items.push(r);
      if (limit && items.length >= limit) break;
    }
    return items;
  }

  clear(): void {
    this.store.clear();
    this.order = [];
    this.totalBytes = 0;
  }

  size(): number {
    return this.store.size;
  }

  bytes(): number {
    return this.totalBytes;
  }
}
