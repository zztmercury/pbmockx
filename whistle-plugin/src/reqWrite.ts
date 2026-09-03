/**
 * reqWrite — pipe hook: transparent passthrough (same as resWrite).
 */

import { passthroughPipe } from './helpers';

export default (server: any, options: any) => {
  server.on('request', (req: any, res: any) => {
    passthroughPipe(req, res, { endOnClose: true });
  });
};
