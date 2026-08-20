/**
 * reqWrite — pipe hook: transparent passthrough (same as resWrite).
 */

export default (server: any, options: any) => {
  server.on('request', (req: any, res: any) => {
    const chunks: Buffer[] = [];
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      try { res.end(Buffer.concat(chunks)); } catch {}
    };
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
  });
};
