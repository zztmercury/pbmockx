/**
 * CGI router for pbmockx plugin uiServer.
 *
 * Endpoints:
 *   GET    /cgi-bin/health            — health check
 *   GET    /cgi-bin/flows              — flow list (?filter=regex)
 *   GET    /cgi-bin/flows/:id          — flow detail (?original=1)
 *   POST   /cgi-bin/decode-pb          — decode PB base64 → field tree
 *   GET    /cgi-bin/rules              — list rules (?type=patch|map_local|map_remote)
 *   POST   /cgi-bin/rules              — add rule
 *   DELETE /cgi-bin/rules/:id          — delete rule
 *   POST   /cgi-bin/rules/save         — save rules.yaml
 *   POST   /cgi-bin/rules/reload       — reload rules.yaml
 *   POST   /cgi-bin/map-local          — add map_local rule (writes mock data file)
 */

import Router from '@koa/router';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pbEngine, rules, flowStore, MOCK_DATA_DIR } from '../ctx';
import { detect } from '../content-type';
import { buildFieldTree, renderTree, type MessageTree } from '../field-tree';
import { MockRule } from '../rules';

// Augment Koa for koa-bodyparser body access
declare module 'koa' {
  interface Request { body: any; }
}

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', '..', 'public');

export default function setupRouter(router: Router) {
  // --- static files from public/ (for inspectorsTab resources) ---
  router.get('/public/:filename', async (ctx) => {
    const fp = path.join(PUBLIC_DIR, ctx.params.filename);
    if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      ctx.type = path.extname(fp);
      ctx.body = fs.createReadStream(fp);
    } else {
      ctx.status = 404;
      ctx.body = 'Not Found';
    }
  });
  // --- health ---
  router.get('/cgi-bin/health', (ctx) => {
    ctx.body = { ok: true, flow_count: flowStore.size(), rules: rules.list().length };
  });

  // --- flows ---
  router.get('/cgi-bin/flows', (ctx) => {
    const filter = ctx.query.filter as string;
    let filterRe: RegExp | undefined;
    if (filter) {
      try { filterRe = new RegExp(filter); } catch { ctx.status = 400; ctx.body = { error: 'invalid filter regex' }; return; }
    }
    const items = flowStore.list(filterRe).map(r => ({
      id: r.id,
      url: r.url,
      method: r.method,
      status: r.status,
      reqProto: r.reqInfo?.protocol,
      resProto: r.resInfo?.protocol,
      hasReq: r.hasReq,
      hasRes: r.hasRes,
      error: r.error,
      patchError: r.patchError,
    }));
    ctx.body = items;
  });

  router.get('/cgi-bin/flows/:id', async (ctx) => {
    const id = ctx.params.id;
    const rec = flowStore.find(id);
    if (!rec) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const original = ctx.query.original !== undefined;
    const result: any = {
      id: rec.id, url: rec.url, method: rec.method, status: rec.status,
      reqHeaders: rec.reqHeaders, resHeaders: rec.resHeaders,
      hasReq: rec.hasReq, hasRes: rec.hasRes,
      error: rec.error, patchError: rec.patchError,
    };

    // Request data
    if (rec.reqInfo && (rec.reqDecoded || original)) {
      const reqInfo = rec.reqInfo;
      const reqData = original && rec.reqOriginalRaw ? await tryDecode(reqInfo, rec.reqOriginalRaw) : rec.reqDecoded;
      if (reqInfo.protocol === 'protobuf' && reqData && reqInfo.desc && reqInfo.messageType) {
        try {
          const MsgType = await pbEngine.getMessageType(reqInfo.desc, reqInfo.messageType);
          const root = MsgType.root as any;
          result.reqData = await buildFieldTree(reqData, MsgType, root);
        } catch { result.reqData = null; }
      } else if (reqInfo.protocol === 'json') {
        result.reqData = reqData;
      }
      result.reqProtocol = reqInfo.protocol;
      result.reqMessageType = reqInfo.messageType;
    }

    // Response data
    if (rec.resInfo && (rec.resDecoded || original)) {
      const resInfo = rec.resInfo;
      const resData = original && rec.resOriginalRaw ? await tryDecode(resInfo, rec.resOriginalRaw) : rec.resDecoded;
      if (resInfo.protocol === 'protobuf' && resData && resInfo.desc && resInfo.messageType) {
        try {
          const MsgType = await pbEngine.getMessageType(resInfo.desc, resInfo.messageType);
          const root = MsgType.root as any;
          result.resData = await buildFieldTree(resData, MsgType, root);
        } catch { result.resData = null; }
      } else if (resInfo.protocol === 'json') {
        result.resData = resData;
      }
      result.resProtocol = resInfo.protocol;
      result.resMessageType = resInfo.messageType;
    }

    ctx.body = result;
  });

  async function tryDecode(info: any, raw: Buffer) {
    if (info.protocol === 'protobuf' && info.desc && info.messageType) {
      return await pbEngine.decode(info.desc, info.messageType, info.delimited, raw);
    } else if (info.protocol === 'json') {
      return JSON.parse(raw.toString('utf-8'));
    }
    return null;
  }

  // --- decode-pb (for inspectorsTab) ---
  router.post('/cgi-bin/decode-pb', async (ctx) => {
    const { base64, desc, messageType, delimited, contentType } = ctx.request.body as any;

    if (!base64) { ctx.status = 400; ctx.body = { error: 'base64 required' }; return; }

    const bytes = Buffer.from(base64, 'base64');

    // If not PB, return JSON pretty
    if (!contentType || !/protobuf/i.test(contentType)) {
      try {
        const json = JSON.parse(bytes.toString('utf-8'));
        ctx.body = { protocol: 'json', data: json, hint: 'JSON response — use Body tab for pretty-JSON view' };
      } catch {
        ctx.body = { protocol: 'unknown', hint: 'Not a Protobuf or JSON response' };
      }
      return;
    }

    if (!desc || !messageType) {
      ctx.body = { protocol: 'protobuf', error: 'missing desc or messageType in Content-Type' };
      return;
    }

    try {
      const decoded = await pbEngine.decode(desc, messageType, !!delimited, bytes);
      const MsgType = await pbEngine.getMessageType(desc, messageType);
      const root = MsgType.root as any;
      const tree = await buildFieldTree(decoded, MsgType, root);
      ctx.body = { protocol: 'protobuf', messageType, data: tree };
    } catch (e: any) {
      ctx.body = { protocol: 'protobuf', messageType, error: e.message };
    }
  });

  // --- rules CRUD ---
  router.get('/cgi-bin/rules', (ctx) => {
    const type = ctx.query.type as any;
    ctx.body = rules.list(type);
  });

  router.post('/cgi-bin/rules', (ctx) => {
    const body = ctx.request.body as any;
    if (!body.url_pattern) { ctx.status = 400; ctx.body = { error: 'url_pattern required' }; return; }
    const rule = new MockRule(body);
    rules.add(rule);
    rules.save();
    ctx.body = { ok: true, rule: rule.toDict() };
  });

  router.delete('/cgi-bin/rules/:id', (ctx) => {
    const ok = rules.delete(ctx.params.id);
    if (ok) rules.save();
    ctx.status = ok ? 200 : 404;
    ctx.body = { ok };
  });

  router.post('/cgi-bin/rules/save', (ctx) => {
    ctx.body = { ok: rules.save() };
  });

  router.post('/cgi-bin/rules/reload', (ctx) => {
    const n = rules.reload();
    ctx.body = { ok: true, reloaded: n };
  });

  // --- map-local (with external data file) ---
  router.post('/cgi-bin/map-local', (ctx) => {
    const body = ctx.request.body as any;
    if (!body.url_pattern) { ctx.status = 400; ctx.body = { error: 'url_pattern required' }; return; }

    const ruleData: any = {
      type: 'map_local',
      url_pattern: body.url_pattern,
      source: body.source || 'data',
    };

    if (body.data !== undefined) {
      // Write data to external file
      const id = body.id || crypto.randomBytes(4).toString('hex');
      const dataFile = `${id}.json`;
      const fp = path.join(MOCK_DATA_DIR, dataFile);
      try { fs.writeFileSync(fp, JSON.stringify(body.data, null, 2)); } catch (e: any) {
        ctx.status = 500; ctx.body = { error: `failed to write mock data: ${e.message}` }; return;
      }
      ruleData.data_file = dataFile;
      ruleData.id = id;
    } else if (body.file_path) {
      ruleData.source = 'file';
      ruleData.file_path = body.file_path;
    }

    // Copy optional PB metadata
    for (const k of ['desc', 'messageType', 'delimited', 'status', 'headers']) {
      if (body[k] !== undefined) ruleData[k] = body[k];
    }

    const rule = new MockRule(ruleData);
    rules.add(rule);
    rules.save();
    ctx.body = { ok: true, rule: rule.toDict() };
  });

  // --- flows clear ---
  router.delete('/cgi-bin/flows', (ctx) => {
    flowStore.clear();
    ctx.body = { ok: true, cleared: true };
  });
}
