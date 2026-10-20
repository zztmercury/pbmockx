/**
 * MockEngine — request-phase (map_remote / map_local file) and response-phase
 * (map_local data / patch) rule execution.
 *
 * Ordering matches the whistle-plugin era:
 *   map_remote (first match) -> map_local(file) (first match)
 *   -> map_local(data) + patch, in rules.yaml storage order.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PBEngine } from '../core/pb-engine';
import { RuleEngine, MockRule } from '../core/rules';
import {
  parsePath,
  setByPath,
  appendByPath,
  insertByPath,
  removeByPath,
  unsetByPath,
} from '../core/path-nav';
import { expandAny, packAny } from '../core/any-expand';
import type { Protocol, DetectInfo } from '../core/content-type';
import type { MatchedRule } from '../core/flow-store';

export interface LocalResponse {
  body?: Buffer;
  /** Large files are streamed instead of being buffered in memory. */
  filePath?: string;
  size?: number;
  status: number;
  headers: Record<string, string>;
}

export interface RequestPlan {
  targetUrl?: string;
  localResponse?: LocalResponse;
  matched: MatchedRule[];
  error?: string;
}

export interface ResponseResult {
  body: Buffer;
  status?: number;
  headers?: Record<string, string>;
  matched: MatchedRule[];
  patched: boolean;
  patchError?: string;
  decodeError?: string;
}

function normalizeReplacement(replacement: string): string {
  // whistle generated `https://<replacement>` for bare targets; keep that
  // behavior so existing rules pointing at 127.0.0.1:port keep working.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(replacement)) return replacement;
  return 'https://' + replacement;
}

function inferContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.pb' || ext === '.protobuf') return 'application/x-protobuf';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export class MockEngine {
  constructor(
    private rules: RuleEngine,
    private pbEngine: PBEngine,
    private mockDataDir: string
  ) {}

  /** Request-phase plan: URL rewrite and/or local file response. */
  async planRequest(url: string): Promise<RequestPlan> {
    const matched: MatchedRule[] = [];
    let targetUrl: string | undefined;
    let localResponse: LocalResponse | undefined;
    let error: string | undefined;

    for (const rule of this.rules.all()) {
      if (rule.type === 'map_remote' && !targetUrl && rule.replacement && rule.matches(url)) {
        try {
          let next: string;
          if (rule.isRegex) {
            next = url.replace(new RegExp(rule.urlPattern), rule.replacement);
          } else {
            next = normalizeReplacement(rule.replacement);
          }
          // Validate. A scheme-less regex result means the replacement was a
          // whole URL; normalize it the same way as the non-regex path.
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(next)) next = normalizeReplacement(next);
          new URL(next);
          targetUrl = next;
          matched.push({ id: rule.id, type: rule.type, phase: 'request', outcome: 'applied' });
        } catch (e: any) {
          error = `map_remote ${rule.id}: ${e.message}`;
          matched.push({ id: rule.id, type: rule.type, phase: 'request', outcome: 'error', detail: e.message });
        }
      }
    }

    for (const rule of this.rules.all()) {
      if (localResponse) break;
      if (rule.type !== 'map_local' || rule.source !== 'file' || !rule.filePath) continue;
      if (!rule.matches(url)) continue;
      try {
        const st = await fs.promises.stat(rule.filePath);
        const headers: Record<string, string> = { ...(rule.headers || {}) };
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['content-type'] = inferContentType(rule.filePath);
        }
        const LOCAL_BUFFER_LIMIT = 1024 * 1024;
        if (st.size <= LOCAL_BUFFER_LIMIT) {
          const body = await fs.promises.readFile(rule.filePath);
          localResponse = { body, size: st.size, status: rule.status || 200, headers };
        } else {
          // APKs / zips / large PBs must not be loaded into memory per request.
          localResponse = { filePath: rule.filePath, size: st.size, status: rule.status || 200, headers };
        }
        matched.push({ id: rule.id, type: rule.type, phase: 'request', outcome: 'applied' });
      } catch (e: any) {
        error = `map_local ${rule.id}: ${e.message}`;
        matched.push({ id: rule.id, type: rule.type, phase: 'request', outcome: 'error', detail: e.message });
      }
    }

    return { targetUrl, localResponse, matched, error };
  }

  /** Whether any response-phase rule matches this URL/protocol. */
  hasResponseRules(url: string, protocol?: Protocol): boolean {
    return this.rules
      .matched(url, protocol)
      .some((r) => r.type === 'patch' || (r.type === 'map_local' && r.source === 'data'));
  }

  /**
   * Apply response-phase rules to a decoded body.
   * Throws only on unexpected programming errors; decode/encode failures are
   * returned as `patchError` so the proxy can fall back to the original body.
   */
  async transformResponse(
    url: string,
    protocol: Protocol,
    info: DetectInfo,
    rawBody: Buffer
  ): Promise<ResponseResult | null> {
    const candidates = this.rules
      .matched(url, protocol)
      .filter((r) => r.type === 'patch' || (r.type === 'map_local' && r.source === 'data'));
    if (!candidates.length) return null;

    const matched: MatchedRule[] = [];
    let data: any;
    try {
      data = await this.decodeBody(protocol, info, rawBody);
    } catch (e: any) {
      return {
        body: rawBody,
        matched: candidates.map((r) => ({
          id: r.id,
          type: r.type,
          phase: 'response',
          outcome: 'error',
          detail: e.message,
        })),
        patched: false,
        decodeError: e.message,
      };
    }

    // Expand Any fields so patch paths can navigate into them.
    let root: any = null;
    let msgType: any = null;
    if (protocol === 'protobuf' && info.desc && info.messageType) {
      try {
        msgType = await this.pbEngine.getMessageType(info.desc, info.messageType);
        root = (msgType as any).root;
        await expandAny(data, msgType, root);
      } catch {
        root = null;
        msgType = null;
      }
    }

    let status: number | undefined;
    const headers: Record<string, string> = {};
    let result = data;

    for (const rule of candidates) {
      try {
        if (rule.type === 'map_local' && rule.source === 'data') {
          result = await this.loadMockData(rule);
          if (rule.status) status = rule.status;
          if (rule.headers) Object.assign(headers, rule.headers);
          matched.push({ id: rule.id, type: rule.type, phase: 'response', outcome: 'applied' });
        } else if (rule.type === 'patch' && rule.path) {
          const parts = parsePath(rule.path);
          switch (rule.action || 'set') {
            case 'append': appendByPath(result, parts, rule.value); break;
            case 'insert': insertByPath(result, parts, rule.index ?? 0, rule.value); break;
            case 'remove': removeByPath(result, parts, rule.index ?? 0); break;
            case 'unset': unsetByPath(result, parts); break;
            case 'set':
            default: setByPath(result, parts, rule.value); break;
          }
          matched.push({ id: rule.id, type: rule.type, phase: 'response', outcome: 'applied' });
        }
      } catch (e: any) {
        matched.push({
          id: rule.id,
          type: rule.type,
          phase: 'response',
          outcome: 'error',
          detail: e.message,
        });
        return {
          body: rawBody,
          matched,
          patched: false,
          patchError: `${rule.type} ${rule.id}: ${e.message}`,
        };
      }
    }

    try {
      if (protocol === 'protobuf' && msgType && root) {
        await packAny(result, msgType, root);
      }
      const body = await this.encodeBody(protocol, info, result, candidates);
      return { body, status, headers, matched, patched: true };
    } catch (e: any) {
      return { body: rawBody, matched, patched: false, patchError: e.message };
    }
  }

  private async loadMockData(rule: MockRule): Promise<any> {
    if (rule.dataFile) {
      const fp = path.join(this.mockDataDir, path.basename(rule.dataFile));
      const content = await fs.promises.readFile(fp, 'utf-8');
      return JSON.parse(content);
    }
    if (rule.data !== undefined) return rule.data;
    throw new Error('map_local(data) rule has neither data_file nor inline data');
  }

  private async decodeBody(protocol: Protocol, info: DetectInfo, body: Buffer): Promise<any> {
    if (protocol === 'protobuf') {
      if (!info.desc || !info.messageType) {
        throw new Error('protobuf response is missing desc/messageType in Content-Type');
      }
      return this.pbEngine.decode(info.desc, info.messageType, info.delimited, body);
    }
    if (protocol === 'json') {
      return JSON.parse(body.toString('utf-8'));
    }
    throw new Error(`unsupported protocol for mock: ${protocol}`);
  }

  private async encodeBody(
    protocol: Protocol,
    info: DetectInfo,
    data: any,
    candidates: MockRule[]
  ): Promise<Buffer> {
    if (protocol === 'json') {
      return Buffer.from(JSON.stringify(data), 'utf-8');
    }
    // A map_local(data) rule may carry its own desc/messageType (for bodies
    // whose Content-Type does not describe the payload); fall back to the
    // response's own Content-Type metadata.
    const dataRule = candidates.find((r) => r.type === 'map_local' && r.source === 'data' && (r.desc || r.messageType));
    const desc = dataRule?.desc || info.desc;
    const messageType = dataRule?.messageType || info.messageType;
    const delimited = dataRule?.delimited ?? info.delimited;
    if (!desc || !messageType) {
      throw new Error('map_local(data) needs desc/messageType (rule or response Content-Type)');
    }
    return this.pbEngine.encode(desc, messageType, delimited, data);
  }
}
