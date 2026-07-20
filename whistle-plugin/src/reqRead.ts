/**
 * reqRead — pipe hook: request decode → patch → re-encode.
 * Stores request data into flow_store (upsert — merges with response if exists).
 */

import { detect, type DetectInfo } from './content-type';
import { pbEngine, rules, flowStore } from './ctx';
import { readBody, cloneData } from './helpers';
import * as zlib from 'zlib';

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

    try {
      let decoded: any;
      if (info.protocol === 'protobuf') {
        if (!info.desc || !info.messageType) { res.end(body); return; }
        decoded = await pbEngine.decode(info.desc, info.messageType, info.delimited, decompressed);
      } else {
        decoded = JSON.parse(decompressed.toString('utf-8'));
      }

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
