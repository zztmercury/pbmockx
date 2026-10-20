/**
 * Control API — /__pbmockx/api/*
 *
 * Response shapes intentionally mirror the old whistle-plugin CGI so the CLI
 * could be ported with near-zero changes. New fields are additive only.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { PbmockxConfig, PbmockxPaths } from '../core/config';
import { localAddresses, readVersion } from '../core/config';
import type { CertAuthority } from '../proxy/ca';
import type { FlowStore, FlowRecord } from '../core/flow-store';
import type { PBEngine } from '../core/pb-engine';
import type { RuleEngine } from '../core/rules';
import { MockRule } from '../core/rules';
import { buildFieldTree } from '../core/field-tree';
import { parseForm } from '../core/content-type';
import { flowSummary } from '../core/flow-view';
import type { EventHub } from './events';

const JSON_LIMIT = 32 * 1024 * 1024;

export interface ApiDeps {
  config: PbmockxConfig;
  paths: PbmockxPaths;
  ca: CertAuthority;
  rules: RuleEngine;
  pbEngine: PBEngine;
  flowStore: FlowStore;
  events: EventHub;
  startedAt: number;
  mockDataDir: string;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  deps: ApiDeps;
}

function json(res: ServerResponse, status: number, body: any): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > JSON_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e: any) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function decodeBody(deps: ApiDeps, info: any, body: Buffer | null | undefined): Promise<any> {
  if (!body || body.length === 0) return null;
  if (!info) return null;
  if (info.protocol === 'protobuf') {
    if (!info.desc || !info.messageType) throw new Error('missing desc/messageType for protobuf body');
    const decoded = await deps.pbEngine.decode(info.desc, info.messageType, !!info.delimited, body);
    const MsgType = await deps.pbEngine.getMessageType(info.desc, info.messageType);
    return buildFieldTree(decoded, MsgType, MsgType.root as any);
  }
  if (info.protocol === 'json') {
    return JSON.parse(body.toString('utf-8'));
  }
  if (info.protocol === 'form') {
    return parseForm(body);
  }
  return null;
}

function parseFilter(raw: string | null): RegExp | undefined {
  if (!raw) return undefined;
  return new RegExp(raw);
}

const detailCache = new Map<string, any>();
const DETAIL_CACHE_MAX = 200;

function cacheDetail(key: string, value: any): any {
  detailCache.set(key, value);
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const first = detailCache.keys().next().value;
    if (first === undefined) break;
    detailCache.delete(first);
  }
  return value;
}

async function flowDetail(deps: ApiDeps, rec: FlowRecord, original: boolean): Promise<any> {
  const key = `${rec.id}:${rec.rev}:${original ? 1 : 0}`;
  if (detailCache.has(key)) return detailCache.get(key);
  const result: any = {
    id: rec.id,
    url: rec.url,
    originalUrl: rec.originalUrl,
    method: rec.method,
    status: rec.status,
    statusText: rec.statusText,
    reqHeaders: rec.reqHeaders,
    resHeaders: rec.resHeaders,
    hasReq: !!rec.hasReq,
    hasRes: !!rec.hasRes,
    error: rec.error,
    patchError: rec.patchError,
    decodeError: rec.decodeError,
    durationMs: rec.durationMs,
    timings: rec.timings,
    matchedRules: rec.matchedRules || [],
    mocked: !!rec.mocked,
    resPatched: !!rec.resPatched,
    upgrade: rec.upgrade,
    reqSize: rec.reqSize,
    resSize: rec.resSize,
    reqTruncated: !!rec.reqTruncated,
    resTruncated: !!rec.resTruncated,
    reqContentEncoding: rec.reqContentEncoding,
    resContentEncoding: rec.resContentEncoding,
  };

  if (rec.reqInfo) {
    result.reqProtocol = rec.reqInfo.protocol;
    result.reqMessageType = rec.reqInfo.messageType;
    try {
      result.reqData = await decodeBody(deps, rec.reqInfo, rec.reqBody);
    } catch (e: any) {
      result.reqDecodeError = e.message;
    }
  }
  if (rec.resInfo) {
    result.resProtocol = rec.resInfo.protocol;
    result.resMessageType = rec.resInfo.messageType;
    const body = original ? rec.resOriginalBody : rec.resBody;
    try {
      result.resData = await decodeBody(deps, rec.resInfo, body);
    } catch (e: any) {
      result.resDecodeError = e.message;
    }
    if (rec.resPatched && !original) result.resPatchedShown = true;
  }
  // Truncated bodies cannot be faithfully decoded.
  if (rec.reqTruncated && result.reqDecodeError === undefined) result.reqDecodeError = 'request body truncated';
  if (rec.resTruncated && result.resDecodeError === undefined) result.resDecodeError = 'response body truncated';

  return cacheDetail(key, result);
}

function publicInfo(deps: ApiDeps): any {
  const ca = (() => {
    try { return deps.ca.info(); } catch { return null; }
  })();
  return {
    version: readVersion(deps.paths),
    port: deps.config.port,
    host: deps.config.host,
    dataDir: deps.paths.dataDir,
    rulesFile: deps.paths.rulesFile,
    mockDataDir: deps.paths.mockDataDir,
    lanAddresses: localAddresses(),
    ui: { lanAccess: deps.config.ui.lanAccess },
    ca,
    startedAt: deps.startedAt,
    uptimeMs: Date.now() - deps.startedAt,
    capture: deps.config.capture,
    proxy: {
      mitm: deps.config.proxy.mitm,
      mitmPorts: deps.config.proxy.mitmPorts,
      bypass: deps.config.proxy.bypass,
    },
  };
}

function dataFile(body: any, deps: ApiDeps, id: string): string {
  const dir = deps.paths.mockDataDir;
  fs.mkdirSync(dir, { recursive: true });
  const name = `${id}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2));
  return name;
}

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async function handle(req, res): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/__pbmockx/api') && p !== '/cgi-bin/rootca' && p !== '/cgi-bin/health') {
      return false;
    }
    const ctx: Ctx = { req, res, url, method: (req.method || 'GET').toUpperCase(), deps };

    try {
      if (p === '/cgi-bin/rootca' || p === '/__pbmockx/api/ca.pem') {
        res.writeHead(200, {
          'content-type': 'application/x-pem-file; charset=utf-8',
          'content-disposition': 'attachment; filename="pbmockx-ca.crt"',
        });
        res.end(deps.ca.getCaPem());
        return true;
      }

      if (p === '/__pbmockx/api/health' || p === '/cgi-bin/health') {
        json(res, 200, {
          ok: true,
          version: readVersion(deps.paths),
          flow_count: deps.flowStore.size(),
          rules: deps.rules.list().length,
          uptime: Date.now() - deps.startedAt,
        });
        return true;
      }

      if (p === '/__pbmockx/api/info') {
        json(res, 200, publicInfo(deps));
        return true;
      }

      if (p === '/__pbmockx/api/events') {
        deps.events.subscribe(req, res);
        return true;
      }

      if (p === '/__pbmockx/api/ca/info') {
        json(res, 200, deps.ca.info());
        return true;
      }

      // --- flows ---
      if (p === '/__pbmockx/api/flows' && ctx.method === 'GET') {
        const filter = parseFilter(url.searchParams.get('filter'));
        const limit = parseInt(url.searchParams.get('limit') || '0', 10) || undefined;
        json(res, 200, deps.flowStore.list(filter, limit).map(flowSummary));
        return true;
      }
      if (p === '/__pbmockx/api/flows' && ctx.method === 'DELETE') {
        deps.flowStore.clear();
        json(res, 200, { ok: true, cleared: true });
        return true;
      }

      let m = /^\/__pbmockx\/api\/flows\/([^/]+)\/body$/.exec(p);
      if (m && ctx.method === 'GET') {
        const rec = deps.flowStore.find(decodeURIComponent(m[1]));
        if (!rec) { json(res, 404, { error: 'not found' }); return true; }
        const part = url.searchParams.get('part') || 'res';
        const body = part === 'req' ? rec.reqBody : part === 'res-original' ? rec.resOriginalBody : rec.resBody;
        if (!body) { json(res, 404, { error: 'no body for part ' + part }); return true; }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        res.end(body);
        return true;
      }

      m = /^\/__pbmockx\/api\/flows\/([^/]+)$/.exec(p);
      if (m && ctx.method === 'GET') {
        const rec = deps.flowStore.find(decodeURIComponent(m[1]));
        if (!rec) { json(res, 404, { error: 'not found' }); return true; }
        const original = url.searchParams.get('original') !== null && url.searchParams.get('original') !== '0';
        json(res, 200, await flowDetail(deps, rec, original));
        return true;
      }

      // --- rules ---
      if (p === '/__pbmockx/api/rules' && ctx.method === 'GET') {
        const type = url.searchParams.get('type') as any;
        json(res, 200, deps.rules.list(type || undefined));
        return true;
      }
      if (p === '/__pbmockx/api/rules' && ctx.method === 'POST') {
        const body = await readJson(req);
        if (!body.url_pattern) { json(res, 400, { error: 'url_pattern required' }); return true; }
        const rule = new MockRule(body);
        deps.rules.add(rule);
        deps.rules.save();
        deps.events.broadcast('rules.changed', { action: 'add', rule: rule.toDict() });
        json(res, 200, { ok: true, rule: rule.toDict() });
        return true;
      }
      if (p === '/__pbmockx/api/rules/save' && ctx.method === 'POST') {
        json(res, 200, { ok: deps.rules.save() });
        return true;
      }
      if (p === '/__pbmockx/api/rules/reload' && ctx.method === 'POST') {
        const n = deps.rules.reload();
        deps.events.broadcast('rules.changed', { action: 'reload', count: n });
        json(res, 200, { ok: true, reloaded: n });
        return true;
      }
      m = /^\/__pbmockx\/api\/rules\/([^/]+)\/enabled$/.exec(p);
      if (m && ctx.method === 'POST') {
        const body = await readJson(req);
        const ok = deps.rules.setEnabled(decodeURIComponent(m[1]), !!body.enabled);
        if (ok) deps.events.broadcast('rules.changed', { action: 'toggle', id: m[1], enabled: !!body.enabled });
        json(res, ok ? 200 : 404, { ok });
        return true;
      }
      m = /^\/__pbmockx\/api\/rules\/([^/]+)$/.exec(p);
      if (m && ctx.method === 'DELETE') {
        const ok = deps.rules.delete(decodeURIComponent(m[1]));
        if (ok) {
          deps.rules.save();
          deps.events.broadcast('rules.changed', { action: 'delete', id: m[1] });
        }
        json(res, ok ? 200 : 404, { ok });
        return true;
      }

      // --- map-local (writes mock data to an external file) ---
      if (p === '/__pbmockx/api/map-local' && ctx.method === 'POST') {
        const body = await readJson(req);
        if (!body.url_pattern) { json(res, 400, { error: 'url_pattern required' }); return true; }
        const ruleData: any = {
          type: 'map_local',
          url_pattern: body.url_pattern,
          source: body.source || 'data',
        };
        if (body.data !== undefined) {
          const id = body.id || crypto.randomBytes(4).toString('hex');
          ruleData.id = id;
          ruleData.data_file = dataFile(body.data, deps, id);
        } else if (body.file_path) {
          ruleData.source = 'file';
          ruleData.file_path = body.file_path;
        } else {
          json(res, 400, { error: 'either data or file_path required' });
          return true;
        }
        for (const k of ['desc', 'messageType', 'delimited', 'status', 'headers', 'enabled']) {
          if (body[k] !== undefined) ruleData[k] = body[k];
        }
        const rule = new MockRule(ruleData);
        deps.rules.add(rule);
        deps.rules.save();
        deps.events.broadcast('rules.changed', { action: 'add', rule: rule.toDict() });
        json(res, 200, { ok: true, rule: rule.toDict() });
        return true;
      }

      // --- mock data files ---
      m = /^\/__pbmockx\/api\/mock-data\/([^/]+)$/.exec(p);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!/^[A-Za-z0-9._-]+$/.test(name)) { json(res, 400, { error: 'invalid file name' }); return true; }
        const fp = path.join(deps.paths.mockDataDir, name);
        if (ctx.method === 'GET') {
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            json(res, 200, { file: name, content });
          } catch (e: any) {
            json(res, 404, { error: e.code === 'ENOENT' ? 'not found' : e.message });
          }
          return true;
        }
        if (ctx.method === 'PUT') {
          const body = await readJson(req);
          const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.data, null, 2);
          try {
            JSON.parse(content);
          } catch (e: any) {
            json(res, 400, { error: 'invalid JSON: ' + e.message });
            return true;
          }
          fs.mkdirSync(deps.paths.mockDataDir, { recursive: true });
          fs.writeFileSync(fp, content);
          deps.events.broadcast('rules.changed', { action: 'mock-data', file: name });
          json(res, 200, { ok: true, file: name });
          return true;
        }
        if (ctx.method === 'DELETE') {
          try { fs.unlinkSync(fp); } catch {}
          json(res, 200, { ok: true });
          return true;
        }
      }

      json(res, 404, { error: 'not found' });
      return true;
    } catch (e: any) {
      if (!res.headersSent) json(res, 400, { error: e.message });
      else try { res.end(); } catch {}
      return true;
    }
  };
}
