/**
 * reqRead — pipe hook: request decode → patch → re-encode.
 * Stores request data into flow_store (upsert — merges with response if exists).
 */

import { detect, parseForm, type DetectInfo } from './content-type';
import { pbEngine, rules, flowStore } from './ctx';
import { readBody, cloneData, pipeLog } from './helpers';
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
    const t0 = Date.now();
    const fullUrl = req.originalReq?.fullUrl || '';
    const sessionId = req.originalReq?.id || fullUrl;
    const reqHeaders = req.headers || {};
    const ct = reqHeaders['content-type'] || '';
    const encoding = reqHeaders['content-encoding'] || '';
    const method = req.originalReq?.method || 'GET';
    const shortUrl = fullUrl.slice(0, 80);

    pipeLog('req', sessionId, `begin ${method} ${shortUrl}`);

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e: any) {
      // Stream errored mid-body — nothing to forward, but must not leave the
      // pipe hanging (whistle waits for res.end()). Flush empty and bail.
      pipeLog('req', sessionId, `read-error ${e?.message || e} elapsed=${Date.now() - t0}ms`);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, reqHeaders,
        error: 'reqRead stream failed: ' + (e?.message || e), ts: Date.now(),
      });
      try { res.end(); } catch {}
      return;
    }
    pipeLog('req', sessionId, `body-read ${body.length}B read=${Date.now() - t0}ms`);

    let decompressed = body;
    if (encoding.includes('gzip')) { try { decompressed = zlib.gunzipSync(body); } catch {} }
    else if (encoding.includes('deflate')) { try { decompressed = zlib.inflateSync(body); } catch {} }
    else if (encoding.includes('br')) { try { decompressed = zlib.brotliDecompressSync(body); } catch {} }

    const info: DetectInfo | null = detect(ct, decompressed);
    if (!info) {
      res.end(body);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, reqHeaders, reqOriginalRaw: decompressed, ts: Date.now(),
      });
      pipeLog('req', sessionId, `-> detect-null ${body.length}B total=${Date.now() - t0}ms`);
      return;
    }

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
      pipeLog('req', sessionId, `-> form ${body.length}B total=${Date.now() - t0}ms`);
      return;
    }

    // 无 patch/map_local(data) 规则时：立即透传原始字节，绝不阻塞转发。
    // 往返会丢弃未知字段/改变字段顺序，字节级改动会破坏依赖原始字节的
    // 请求签名（如 X-Tap-Sign），导致服务端 400。
    // 关键：不在此处 decode——decode 会触发 desc 下载 + 同步构建 descriptor
    // root（实测 775ms），阻塞所有 pipe hook 共享的事件循环，短超时请求会先
    // 被客户端关闭。改为只记录 raw body，按需在 CGI/CLI 查询时再 decode。
    if (!rules.hasDataRules(fullUrl, info.protocol)) {
      res.end(body);
      flowStore.upsert(sessionId, {
        url: fullUrl, method,
        reqHeaders, reqInfo: info, reqDecoded: null, reqOriginalRaw: decompressed,
        ts: Date.now(),
      });
      pipeLog('req', sessionId, `-> forwarded ${body.length}B total=${Date.now() - t0}ms`);
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
      pipeLog('req', sessionId, `-> patched ${encoded.length}B total=${Date.now() - t0}ms`);
    } catch (e: any) {
      console.error('[pbmockx] reqRead error ' + fullUrl + ':', e.message);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, reqHeaders, reqInfo: info, reqDecoded: null, reqOriginalRaw: decompressed,
        error: e.message, ts: Date.now(),
      });
      pipeLog('req', sessionId, `-> error ${e.message} total=${Date.now() - t0}ms`);
      res.end(body);
    }
  });
};
