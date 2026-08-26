/**
 * resWrite — pipe hook: transparent passthrough.
 *
 * Flow: target server → [resRead] → whistle internal → [resWrite] → client
 *
 * resRead already decoded → patched → re-encoded the response. This hook
 * does nothing — just passes the body through unchanged.
 */

import { isSse } from './content-type';
import { endPipe, passthroughPipe, pipeLog } from './helpers';

export default (server: any, options: any) => {
  server.on('request', (req: any, res: any) => {
    const sessionId = req.originalReq?.id || req.originalReq?.fullUrl || '';
    pipeLog('res', sessionId, 'write-begin');
    if (isSse(req.headers)) {
      pipeLog('res', sessionId, 'write-sse-passthrough');
      passthroughPipe(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    let ended = false;
    const finish = (why: string) => {
      if (ended) return;
      ended = true;
      const body = Buffer.concat(chunks);
      pipeLog('res', sessionId, `write-end ${body.length}B via=${why}`);
      endPipe(res, body);
    };
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => finish('end'));
    // whistle pipe decoder emits 'close' without 'end' on socket reset/client
    // disconnect — must still flush so the pipe never hangs.
    req.on('error', () => finish('error'));
    req.on('close', () => finish('close'));
  });
};
