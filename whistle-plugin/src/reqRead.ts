/**
 * reqRead — pipe hook: request decode → patch → re-encode.
 * Stores request data into flow_store (upsert — merges with response if exists).
 */

import { detect, parseForm, type DetectInfo } from './content-type';
import { pbEngine, rules, flowStore } from './ctx';
import { readBody, cloneData } from './helpers';
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
    const reqHeaders = req.headers || {};
    const ct = reqHeaders['content-type'] || '';
    const encoding = reqHeaders['content-encoding'] || '';
    const method = req.originalReq?.method || 'GET';

    let body = await readBody(req);

    let decompressed = body;
    if (encoding.includes('gzip')) { try { decompressed = zlib.gunzipSync(body); } catch {} }
    else if (encoding.includes('deflate')) { try { decompressed = zlib.inflateSync(body); } catch {} }
    else if (encoding.includes('br')) { try { decompressed = zlib.brotliDecompressSync(body); } catch {} }

    const info: DetectInfo | null = detect(ct, decompressed);
    if (!info) { res.end(body); return; }

    // Form (urlencoded) bodies: parse for display only, pass through unchanged (no patch).
    if (info.protocol === 'form') {
      // 立即转发，不阻塞；解析仅用于展示。
      res.end(body);
      let parsed: any = null;
      try { parsed = parseForm(decompressed); }
      catch (e: any) { console.error('[pbmockx] reqRead form parse error ' + fullUrl + ':', e.message); }
      flowStore.upsert(sessionId, {
        url: fullUrl, method,
        reqHeaders, reqInfo: info, reqDecoded: parsed, reqOriginalRaw: decompressed,
        ts: Date.now(),
      });
      return;
    }

    // 无 patch/map_local(data) 规则时：立即透传原始字节，绝不阻塞转发。
    // 往返会丢弃未知字段/改变字段顺序，字节级改动会破坏依赖原始字节的
    // 请求签名（如 X-Tap-Sign），导致服务端 400。decode 仅用于展示。
    // 关键：decode 会触发 desc 下载（DescCache 每次发条件请求，timeout 10s），
    // 若同步等待会阻塞请求体转发，导致上游等 body 超时（POST 超时、GET 正常）。
    if (!rules.hasDataRules(fullUrl, info.protocol)) {
      res.end(body);
      decodeForDisplay(info, decompressed)
        .then(decoded => {
          flowStore.upsert(sessionId, {
            url: fullUrl, method,
            reqHeaders, reqInfo: info, reqDecoded: decoded, reqOriginalRaw: decompressed,
            ts: Date.now(),
          });
        })
        .catch(e => {
          flowStore.upsert(sessionId, {
            url: fullUrl, method, reqHeaders, reqInfo: info, reqDecoded: null, reqOriginalRaw: decompressed,
            error: e.message, ts: Date.now(),
          });
        });
      return;
    }

    // 有 patch/map_local(data) 规则：必须 decode → patch → encode 后转发。
    try {
      let decoded: any = await decodeForDisplay(info, decompressed);
      if (decoded == null) { res.end(body); return; }

      const patched = rules.apply(fullUrl, info.protocol, decoded);

      let encoded: Buffer;
      if (info.protocol === 'protobuf') {
        encoded = await pbEngine.encode(info.desc!, info.messageType!, info.delimited, patched);
      } else {
        encoded = Buffer.from(JSON.stringify(patched), 'utf-8');
      }

      flowStore.upsert(sessionId, {
        url: fullUrl, method,
        reqHeaders, reqInfo: info, reqDecoded: patched, reqOriginalRaw: decompressed,
        ts: Date.now(),
      });

      res.end(encoded);
    } catch (e: any) {
      console.error('[pbmockx] reqRead error ' + fullUrl + ':', e.message);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, reqHeaders, reqInfo: info, reqDecoded: null, reqOriginalRaw: decompressed,
        error: e.message, ts: Date.now(),
      });
      res.end(body);
    }
  });
};
