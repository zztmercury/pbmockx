/**
 * Shared helpers for pipe hooks.
 */

import * as crypto from 'crypto';
import * as zlib from 'zlib';

/** Read all data from a readable stream into a Buffer. */
export function readBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const onData = (c: Buffer) => chunks.push(c);
    const onEnd = () => settle();
    const onError = (e: any) => settle(e);
    // whistle pipe decoder emits 'close' (NOT 'end'/'error') when the socket
    // is reset or the client disconnects mid-body. If the stream already ended
    // (readableEnded), close is a normal post-end cleanup → resolve. Otherwise
    // close means we got torn down before the \n0\n terminal frame → reject so
    // the hook can record the abort instead of treating partial bytes as a
    // complete body.
    const onClose = () => {
      if (req.readableEnded) settle();
      else settle(new Error('pipe closed before terminal frame'));
    };

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };

    const settle = (err?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);

    // Defensive: stream may already be fully consumed/ended before we attached.
    if (req.readableEnded) settle();
  });
}

/**
 * 透传：按 chunk write，不 buffer 整段 body。
 * 默认只在 end/error 关流；close 在 SSE 存活期间也会发，不能当结束。
 * 有限长度的普通 HTTP 在 abort 时可能只有 close，需要 endOnClose。
 */
export function passthroughPipe(req: any, res: any, opts?: { endOnClose?: boolean }): void {
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    try { res.end(); } catch {}
  };
  req.on('data', (c: Buffer) => {
    if (ended) return;
    try { res.write(c); } catch { finish(); }
  });
  req.on('end', finish);
  req.on('error', finish);
  if (opts?.endOnClose) req.on('close', finish);
}

/**
 * 透传并收集完整 body（转发不阻塞：每个 chunk 立刻 write）。
 * 用于请求记录、以及无 mock 规则的响应记录。
 */
export function tapAndPassthrough(req: any, res: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { res.end(); } catch {}
      resolve(Buffer.concat(chunks));
    };
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (done) return;
      try { res.write(c); } catch { finish(); }
    });
    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
    if (req.readableEnded) finish();
  });
}

/** gunzip / inflate / brotli；失败则返回原字节。 */
export function decompressBody(body: Buffer, encoding: string): Buffer {
  if (!encoding) return body;
  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(body);
    if (encoding.includes('deflate')) return zlib.inflateSync(body);
    if (encoding.includes('br')) return zlib.brotliDecompressSync(body);
  } catch {}
  return body;
}

/** Generate a short flow ID. */
export function genFlowId(url: string, ts: number): string {
  const hash = crypto.createHash('md5').update(`${url}${ts}`).digest('hex');
  return hash.substring(0, 8);
}

/** Deep clone a PB message object or JSON object. */
export async function cloneData(
  data: any,
  protocol: 'protobuf' | 'json',
  pbEngine?: any,
  desc?: string,
  messageType?: string,
  delimited?: boolean
): Promise<any> {
  if (protocol === 'json') {
    return JSON.parse(JSON.stringify(data));
  }
  // PB: re-encode and re-decode for a proper deep copy
  if (pbEngine && desc && messageType) {
    const encoded = await pbEngine.encode(desc, messageType, delimited || false, data);
    return await pbEngine.decode(desc, messageType, delimited || false, encoded);
  }
  return data;
}
