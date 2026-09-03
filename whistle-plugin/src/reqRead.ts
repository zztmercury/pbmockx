/**
 * reqRead — pipe hook: record request body, never mock, never block.
 * Stores request data into flow_store (upsert — merges with response if exists).
 */

import { detect, parseForm, type DetectInfo } from './content-type';
import { flowStore } from './ctx';
import { tapAndPassthrough, decompressBody } from './helpers';

export default (server: any, options: any) => {
  server.on('request', async (req: any, res: any) => {
    const fullUrl = req.originalReq?.fullUrl || '';
    const sessionId = req.originalReq?.id || fullUrl;
    const reqHeaders = req.headers || {};
    const ct = reqHeaders['content-type'] || '';
    const encoding = reqHeaders['content-encoding'] || '';
    const method = req.originalReq?.method || 'GET';

    flowStore.upsert(sessionId, {
      url: fullUrl, method, reqHeaders, ts: Date.now(),
    });

    const body = await tapAndPassthrough(req, res);
    const decompressed = decompressBody(body, encoding);
    const info: DetectInfo | null = detect(ct, decompressed);

    const rec: any = {
      url: fullUrl, method, reqHeaders, reqOriginalRaw: decompressed, ts: Date.now(),
    };
    if (info) {
      rec.reqInfo = info;
      if (info.protocol === 'form') {
        try { rec.reqDecoded = parseForm(decompressed); }
        catch (e: any) { console.error('[pbmockx] reqRead form parse error ' + fullUrl + ':', e.message); }
      } else {
        rec.reqDecoded = null;
      }
    }
    flowStore.upsert(sessionId, rec);
  });
};
