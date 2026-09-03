/**
 * resWrite — pipe hook: transparent passthrough.
 *
 * Flow: target server → [resRead] → whistle internal → [resWrite] → client
 *
 * resRead already decoded → patched → re-encoded the response (when mock
 * rules match). This hook does nothing — just passes the body through.
 */

import { isSse } from './content-type';
import { passthroughPipe } from './helpers';

export default (server: any, options: any) => {
  server.on('request', (req: any, res: any) => {
    // SSE 存活期间 decoder 也会发 close，不能当结束。
    passthroughPipe(req, res, { endOnClose: !isSse(req.headers) });
  });
};
