/**
 * HTTP body + header helpers shared by the proxy, mock engine and recorder.
 */

import * as zlib from 'zlib';

export function getHeader(headers: Record<string, any> | undefined, name: string): string {
  if (!headers) return '';
  const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(v)) return v.join(', ');
  return v == null ? '' : String(v);
}

/** Keep multi-value headers (set-cookie) intact; drop undefined values. */
export function normalizeHeaders(headers: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = v;
  }
  return out;
}

const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request headers safe to forward to the upstream server. */
export function requestHeaders(headers: Record<string, any>, host: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (v === undefined) continue;
    out[key] = v;
  }
  out.host = host;
  return out;
}

/** Response headers safe to send to the client (body may be rewritten). */
export function responseHeaders(
  headers: Record<string, any>,
  opts: { dropEncoding?: boolean; dropLength?: boolean } = {}
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (opts.dropEncoding && key === 'content-encoding') continue;
    if (opts.dropLength && key === 'content-length') continue;
    if (v === undefined) continue;
    out[key] = v;
  }
  return out;
}

export interface DecodeResult {
  data: Buffer;
  error?: string;
}

/**
 * Decode a Content-Encoding chain. Content-Encoding lists encodings in the
 * order they were applied ("gzip, br" = br then gzip? per RFC the codings are
 * listed in the order applied, so decoding walks the list in reverse).
 */
export function decompressBody(body: Buffer, encoding: string): DecodeResult {
  const codings = (encoding || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((c) => c !== 'identity');
  if (!codings.length) return { data: body };

  let data = body;
  for (let i = codings.length - 1; i >= 0; i--) {
    const c = codings[i];
    try {
      if (c === 'gzip' || c === 'x-gzip') data = zlib.gunzipSync(data);
      else if (c === 'deflate') data = zlib.inflateSync(data);
      else if (c === 'br') data = zlib.brotliDecompressSync(data);
      else return { data: body, error: `unsupported content-encoding: ${c}` };
    } catch (e: any) {
      return { data: body, error: `failed to decode ${c}: ${e.message}` };
    }
  }
  return { data };
}

/** Re-encode using the same Content-Encoding chain (used after rewriting). */
export function compressBody(body: Buffer, encoding: string): DecodeResult {
  const codings = (encoding || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((c) => c !== 'identity');
  if (!codings.length) return { data: body };

  let data = body;
  for (const c of codings) {
    try {
      if (c === 'gzip' || c === 'x-gzip') data = zlib.gzipSync(data);
      else if (c === 'deflate') data = zlib.deflateSync(data);
      else if (c === 'br') data = zlib.brotliCompressSync(data);
      else return { data: body, error: `unsupported content-encoding: ${c}` };
    } catch (e: any) {
      return { data: body, error: `failed to encode ${c}: ${e.message}` };
    }
  }
  return { data };
}

/** Accumulates a bounded copy of a stream while it flows to the client. */
export class BodyTap {
  readonly max: number;
  total = 0;
  truncated = false;
  private chunks: Buffer[] = [];
  private stored = 0;

  constructor(max: number) {
    this.max = Math.max(0, max);
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.stored >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.stored;
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.stored += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, room));
      this.stored += room;
      this.truncated = true;
    }
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Collect an entire stream body, aborting once `max` bytes are exceeded. */
export function collectBody(stream: any, max: number): Promise<{ body: Buffer; truncated: boolean; total: number; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ body: Buffer.concat(chunks), truncated: error === 'too-large', total, error });
    };
    const onData = (c: Buffer) => {
      total += c.length;
      if (total > max) {
        finish('too-large');
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => finish();
    const onError = (e: any) => finish('stream error: ' + (e && e.message ? e.message : e));
    const onClose = () => {
      if (!done) finish('stream closed');
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
    if (stream.readableEnded) finish();
  });
}

export function isEventStream(headers: Record<string, any> | undefined): boolean {
  const ct = getHeader(headers, 'content-type');
  const accept = getHeader(headers, 'accept');
  return /text\/event-stream/i.test(ct) || /text\/event-stream/i.test(accept);
}

export function statusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 413: 'Payload Too Large',
    421: 'Misdirected Request', 429: 'Too Many Requests', 500: 'Internal Server Error',
    501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  return map[code] || '';
}
