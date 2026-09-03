/**
 * resRead — pipe hook: response decode → patch → re-encode, only when
 * Content-Type is JSON/PB and a patch/map_local(data) rule matches.
 * Otherwise tap-and-passthrough (record, never block).
 *
 * In pipe resRead, response headers are in req.headers (not req.originalRes.headers).
 */

import { detect, parseForm, isSse, isJsonOrPbCt, protocolFromCt, type DetectInfo } from './content-type';
import { pbEngine, rules, flowStore } from './ctx';
import { readBody, passthroughPipe, tapAndPassthrough, decompressBody } from './helpers';
import { expandAny, packAny } from './any-expand';

async function decodeForPatch(info: DetectInfo, data: Buffer): Promise<any> {
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

    // 立即记录响应元数据（status/headers），即使后续 body 失败，
    // flow 也有响应状态，不会出现 status 空 → 便于定位超时。
    flowStore.upsert(sessionId, {
      url: fullUrl, method, status: statusCode, resHeaders, ts: Date.now(),
    });

    if (isSse(resHeaders)) {
      passthroughPipe(req, res);
      return;
    }

    const proto = protocolFromCt(ct);
    const shouldMock = isJsonOrPbCt(resHeaders) && !!proto && rules.hasDataRules(fullUrl, proto);

    if (!shouldMock) {
      const body = await tapAndPassthrough(req, res);
      const decompressed = decompressBody(body, encoding);
      const info: DetectInfo | null = detect(ct, decompressed);
      const rec: any = {
        url: fullUrl, method, status: statusCode, resHeaders,
        resOriginalRaw: decompressed, ts: Date.now(),
      };
      if (info) {
        rec.resInfo = info;
        rec.resDecoded = null;
        if (info.protocol === 'form') {
          try { rec.resDecoded = parseForm(decompressed); }
          catch (e: any) { console.error('[pbmockx] resRead form parse error ' + fullUrl + ':', e.message); }
        }
      }
      flowStore.upsert(sessionId, rec);
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e: any) {
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode, resHeaders,
        error: 'resRead stream failed: ' + (e?.message || e), ts: Date.now(),
      });
      try { res.end(); } catch {}
      return;
    }

    const decompressed = decompressBody(body, encoding);
    const info: DetectInfo | null = detect(ct, decompressed);
    if (!info || (info.protocol !== 'protobuf' && info.protocol !== 'json')) {
      res.end(body);
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode, resHeaders,
        resOriginalRaw: decompressed, ts: Date.now(),
      });
      return;
    }

    try {
      let decoded: any = await decodeForPatch(info, decompressed);
      if (decoded == null) { res.end(body); return; }

      if (info.protocol === 'protobuf' && info.desc && info.messageType) {
        try {
          const MsgType = await pbEngine.getMessageType(info.desc, info.messageType);
          await expandAny(decoded, MsgType, MsgType.root as any);
        } catch {}
      }

      const patched = rules.apply(fullUrl, info.protocol, decoded);

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
