/**
 * Shared helpers for pipe hooks.
 */

import * as crypto from 'crypto';

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
