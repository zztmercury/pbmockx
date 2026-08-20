/**
 * resWrite — pipe hook: transparent passthrough.
 *
 * Flow: target server → [resRead] → whistle internal → [resWrite] → client
 *
 * resRead already decoded → patched → re-encoded the response. This hook
 * does nothing — just passes the body through unchanged.
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
    // whistle pipe decoder emits 'close' without 'end' on socket reset/client
    // disconnect — must still flush so the pipe never hangs.
    req.on('error', finish);
    req.on('close', finish);
  });
};
