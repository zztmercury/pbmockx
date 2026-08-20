/**
 * resRead — pipe hook: response decode → patch → re-encode.
 * Stores response data into flow_store (upsert — merges with request if exists).
 *
 * In pipe resRead, response headers are in req.headers (not req.originalRes.headers).
 */

import { detect, parseForm, type DetectInfo } from './content-type';
import { pbEngine, rules, flowStore } from './ctx';
import { readBody, cloneData } from './helpers';
import { expandAny, packAny } from './any-expand';
import * as zlib from 'zlib';

/** 仅用于展示的解码（不阻塞转发）。protobuf 需 desc 下载，放异步。 */
async function decodeForDisplay(info: DetectInfo, data: Buffer): Promise<any> {
  if (info.protocol === 'protobuf') {
    if (!info.desc || !info.messageType) return null;
    return await pbEngine.decode(info.desc, info.messageType, info.delimited, data);
  }
  return JSON.parse(data.toString('utf-8'));
}

export default (server: any, options: any) => {
  server.on('request', async (req: any, res: any) => {
    const fullUrl = req.originalReq?.fullUrl || '';
    const sessionId = req.originalReq?.id || fullUrl;
    const resHeaders = req.headers || {};
    const ct = resHeaders['content-type'] || '';
    const encoding = resHeaders['content-encoding'] || '';
    const statusCode = req.originalRes?.statusCode || 200;
    const method = req.originalReq?.method || 'GET';

    // 立即记录响应元数据（status/headers），即使后续 readBody 失败或 decode
    // 被跳过，flow 也有响应状态，不会出现 status 空 → 便于定位超时。
    flowStore.upsert(sessionId, {
      url: fullUrl, method, status: statusCode, resHeaders, ts: Date.now(),
    });

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e: any) {
      // Stream errored mid-body — nothing to forward, but must not leave the
      // pipe hanging (whistle waits for res.end()). Flush empty and bail.
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode, resHeaders,
        error: 'resRead stream failed: ' + (e?.message || e), ts: Date.now(),
      });
      try { res.end(); } catch {}
      return;
    }

    let decompressed = body;
    if (encoding.includes('gzip')) { try { decompressed = zlib.gunzipSync(body); } catch {} }
    else if (encoding.includes('deflate')) { try { decompressed = zlib.inflateSync(body); } catch {} }
    else if (encoding.includes('br')) { try { decompressed = zlib.brotliDecompressSync(body); } catch {} }

    const info: DetectInfo | null = detect(ct, decompressed);
    if (!info) {
      res.end(body);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode, resHeaders,
        resOriginalRaw: decompressed, ts: Date.now(),
      });
      return;
    }

    // Form (urlencoded) bodies: parse for display only, pass through unchanged (no patch).
    if (info.protocol === 'form') {
      // 立即转发，不阻塞；解析仅用于展示。
      res.end(body);
      let parsed: any = null;
      try { parsed = parseForm(decompressed); }
      catch (e: any) { console.error('[pbmockx] resRead form parse error ' + fullUrl + ':', e.message); }
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode,
        resHeaders, resInfo: info, resDecoded: parsed, resOriginalRaw: decompressed,
        ts: Date.now(),
      });
      return;
    }

    // 无 patch/map_local(data) 规则时：立即透传原始字节，绝不阻塞转发。
    // 关键：不在此处 decode——decode 会触发 desc 下载 + 同步构建 descriptor
    // root（实测 775ms），阻塞所有 pipe hook 共享的事件循环，短超时请求会先
    // 被客户端关闭。改为只记录 raw body，按需在 CGI/CLI 查询时再 decode。
    if (!rules.hasDataRules(fullUrl, info.protocol)) {
      res.end(body);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode,
        resHeaders, resInfo: info, resDecoded: null, resOriginalRaw: decompressed,
        ts: Date.now(),
      });
      return;
    }

    // 有 patch/map_local(data) 规则：必须 decode → patch → encode 后转发。
    try {
      let decoded: any = await decodeForDisplay(info, decompressed);
      if (decoded == null) { res.end(body); return; }

      // Expand Any fields so patch path can navigate through them
      if (info.protocol === 'protobuf' && info.desc && info.messageType) {
        try {
          const MsgType = await pbEngine.getMessageType(info.desc, info.messageType);
          await expandAny(decoded, MsgType, MsgType.root as any);
        } catch {}
      }

      const patched = rules.apply(fullUrl, info.protocol, decoded);

      // Pack Any fields back to bytes (after patch)
      if (info.protocol === 'protobuf' && info.desc && info.messageType) {
        try {
          const MsgType = await pbEngine.getMessageType(info.desc, info.messageType);
          await packAny(patched, MsgType, MsgType.root as any);
        } catch {}
      }

      let encoded: Buffer;
      if (info.protocol === 'protobuf') {
        encoded = await pbEngine.encode(info.desc!, info.messageType!, info.delimited, patched);
      } else {
        encoded = Buffer.from(JSON.stringify(patched), 'utf-8');
      }

      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode,
        resHeaders, resInfo: info, resDecoded: patched, resOriginalRaw: decompressed,
        ts: Date.now(),
      });

      res.end(encoded);
    } catch (e: any) {
      console.error('[pbmockx] resRead error ' + fullUrl + ':', e.message);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode,
        resHeaders, resInfo: info, resDecoded: null, resOriginalRaw: decompressed,
        error: e.message, ts: Date.now(),
      });
      res.end(body);
    }
  });
};
