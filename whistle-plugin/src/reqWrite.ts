/**
 * reqWrite — pipe hook: transparent passthrough (same as resWrite).
 */

import { isSse } from './content-type';
import { endPipe, passthroughPipe, pipeLog } from './helpers';

export default (server: any, options: any) => {
  server.on('request', (req: any, res: any) => {
    const sessionId = req.originalReq?.id || req.originalReq?.fullUrl || '';
    pipeLog('req', sessionId, 'write-begin');
    if (isSse(req.headers)) {
      pipeLog('req', sessionId, 'write-sse-passthrough');
      passthroughPipe(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    let ended = false;
    const finish = (why: string) => {
      if (ended) return;
      ended = true;
      const body = Buffer.concat(chunks);
      pipeLog('req', sessionId, `write-end ${body.length}B via=${why}`);
      endPipe(res, body);
    };
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => finish('end'));
    req.on('error', () => finish('error'));
    req.on('close', () => finish('close'));
  });
};
