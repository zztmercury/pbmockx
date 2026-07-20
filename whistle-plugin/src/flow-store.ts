/**
 * FlowStore — LRU store for decoded sessions.
 *
 * Each flow record holds BOTH request and response data (if available).
 * reqRead and resRead use the same flow ID (whistle session ID) via upsert().
 */

import type { DetectInfo } from './content-type';

export interface FlowRecord {
  id: string;
  url: string;
  method: string;
  status: number | null;
  // Request data (from reqRead)
  reqHeaders?: Record<string, string>;
  reqInfo?: DetectInfo;
  reqDecoded?: any;
  reqOriginalRaw?: Buffer | null;
  // Response data (from resRead)
  resHeaders?: Record<string, string>;
  resInfo?: DetectInfo;
  resDecoded?: any;
  resOriginalRaw?: Buffer | null;
  // Status flags
  hasReq?: boolean;
  hasRes?: boolean;
  error?: string;
  patchError?: string;
  ts: number;
}

const MAX_FLOWS = 500;

export class FlowStore {
  private store = new Map<string, FlowRecord>();
  private order: string[] = [];

  /** Insert or update — merges request/response data into one record. */
  upsert(id: string, patch: Partial<FlowRecord>): FlowRecord {
    let rec = this.store.get(id);
    if (rec) {
      // Merge patch into existing record
      Object.assign(rec, patch);
      if (patch.reqDecoded !== undefined) rec.hasReq = true;
      if (patch.resDecoded !== undefined || patch.resHeaders !== undefined) rec.hasRes = true;
    } else {
      rec = {
        id,
        url: patch.url || '',
        method: patch.method || '',
        status: null,
        hasReq: patch.reqDecoded !== undefined,
        hasRes: patch.resDecoded !== undefined || patch.resHeaders !== undefined,
        ts: Date.now(),
        ...patch,
      };
      this.store.set(id, rec);
      this.order.push(id);
      while (this.order.length > MAX_FLOWS) {
        const old = this.order.shift()!;
        this.store.delete(old);
      }
    }
    return rec;
  }

  find(idPrefix: string): FlowRecord | null {
    if (this.store.has(idPrefix)) return this.store.get(idPrefix)!;
    for (const [k, v] of this.store) {
      if (k.startsWith(idPrefix)) return v;
    }
    return null;
  }

  list(filterRe?: RegExp): FlowRecord[] {
    const items = Array.from(this.store.values()).reverse();
    return filterRe ? items.filter(r => filterRe.test(r.url)) : items;
  }

  clear(): void {
    this.store.clear();
    this.order = [];
  }

  size(): number {
    return this.store.size;
  }
}
