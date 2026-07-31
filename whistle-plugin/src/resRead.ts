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

export default (server: any, options: any) => {
  server.on('request', async (req: any, res: any) => {
    const fullUrl = req.originalReq?.fullUrl || '';
    const sessionId = req.originalReq?.id || fullUrl;
    const resHeaders = req.headers || {};
    const ct = resHeaders['content-type'] || '';
    const encoding = resHeaders['content-encoding'] || '';
    const statusCode = req.originalRes?.statusCode || 200;
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
      let parsed: any = null;
      try { parsed = parseForm(decompressed); }
      catch (e: any) { console.error('[pbmockx] resRead form parse error ' + fullUrl + ':', e.message); }
      flowStore.upsert(sessionId, {
        url: fullUrl, method, status: statusCode,
        resHeaders, resInfo: info, resDecoded: parsed, resOriginalRaw: decompressed,
        ts: Date.now(),
      });
      res.end(body);
      return;
    }

    try {
      let decoded: any;
      if (info.protocol === 'protobuf') {
        if (!info.desc || !info.messageType) { res.end(body); return; }
        decoded = await pbEngine.decode(info.desc, info.messageType, info.delimited, decompressed);
      } else {
        decoded = JSON.parse(decompressed.toString('utf-8'));
      }

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
