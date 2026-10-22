/**
 * ProxyEngine — HTTP/1.1 forward proxy + HTTPS CONNECT MITM + WebSocket tunnel.
 *
 * The same engine serves:
 *   - plain HTTP proxy requests (absolute-form URL)
 *   - origin-form requests received on an intercepted TLS socket
 *   - CONNECT tunnels (TLS MITM on configured ports, raw TCP otherwise)
 *
 * Body recording is best-effort and bounded; response rewriting only happens
 * when a JSON/PB response matches a response-phase rule and is not an SSE
 * stream. Everything else is streamed with backpressure.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { URL } from 'url';

import type { PbmockxConfig } from '../core/config';
import { isLoopbackAddress } from '../core/config';
import type { FlowStore, MatchedRule, TunnelClose, TunnelReason } from '../core/flow-store';
import { flowSummary } from '../core/flow-view';
import {
  BodyTap,
  collectBody,
  compressBody,
  decompressBody,
  getHeader,
  isEventStream,
  normalizeHeaders,
  requestHeaders,
  responseHeaders,
  statusText,
} from '../core/http-body';
import { detect, protocolFromCt, parseForm } from '../core/content-type';
import { log } from '../core/logger';
import type { CertAuthority } from './ca';
import type { MockEngine } from '../mock/engine';
import type { EventHub } from '../server/events';

export interface ProxyDeps {
  config: PbmockxConfig;
  ca: CertAuthority;
  flowStore: FlowStore;
  mock: MockEngine;
  events: EventHub;
}

interface ReqCtx {
  id: string;
  url: string;
  rulesUrl: string;
  start: number;
  timings: any;
  req: any;
  res: any;
  method: string;
  reqTap: BodyTap;
  tapStarted?: boolean;
  upstream?: any;
}

function fullUrl(req: any, scheme: string): string {
  const raw = req.url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const host = req.headers.host;
  if (!host) return `${scheme}://localhost${raw}`;
  return `${scheme}://${host}${raw}`;
}

function stripBrackets(host: string): string {
  return (host || '').replace(/^\[|\]$/g, '');
}

/** `host:port`, bracketing IPv6 literals; port kept only when non-default. */
function formatAuthority(host: string, port: number, omitDefault = false): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  if (omitDefault && port === 443) return h;
  return `${h}:${port}`;
}

function parseAuthority(authority: string): { host: string; port: number } {
  try {
    const u = new URL('http://' + authority);
    return { host: stripBrackets(u.hostname), port: parseInt(u.port, 10) || 443 };
  } catch {
    const i = authority.lastIndexOf(':');
    if (i < 0) return { host: stripBrackets(authority), port: 443 };
    return { host: stripBrackets(authority.slice(0, i)), port: parseInt(authority.slice(i + 1), 10) || 443 };
  }
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-f:]+$/i.test(h);
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function matchesBypass(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of patterns) {
    const p = String(raw || '').toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) {
      if (h === p.slice(2) || h.endsWith(p.slice(1))) return true;
    } else if (p.startsWith('.')) {
      if (h.endsWith(p)) return true;
    } else if (h === p || h.endsWith('.' + p)) {
      return true;
    }
  }
  return false;
}

export class ProxyEngine {
  private config: PbmockxConfig;
  private ca: CertAuthority;
  private store: FlowStore;
  private mock: MockEngine;
  private events: EventHub;

  private httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  private httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });
  private httpsInsecureAgent = new https.Agent({ keepAlive: true, maxSockets: 128, rejectUnauthorized: false });
  private inner: http.Server;
  private tlsServers = new Set<tls.Server>();
  private sockets = new Set<net.Socket>();
  private seq = 0;

  constructor(deps: ProxyDeps) {
    this.config = deps.config;
    this.ca = deps.ca;
    this.store = deps.flowStore;
    this.mock = deps.mock;
    this.events = deps.events;

    this.inner = http.createServer((req, res) => this.handleRequest(req, res, 'https'));
    this.inner.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head, 'https'));
    this.inner.on('clientError', (err, socket: any) => {
      log.debug('inner clientError:', err.message);
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    });
  }

  private nextId(): string {
    const base = Date.now();
    for (let i = 0; i < 1000; i++) {
      this.seq = (this.seq + 1) % 1000;
      const id = `${base}-${String(this.seq).padStart(3, '0')}`;
      if (!this.store.has(id)) return id;
    }
    return `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }

  handleRequest(req: any, res: any, scheme: 'http' | 'https'): void {
    this._handleRequest(req, res, scheme).catch((e: any) => {
      log.error('proxy request failed:', e && e.stack ? e.stack : e);
      try {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('pbmockx: ' + (e && e.message ? e.message : 'internal error'));
      } catch {}
    });
  }

  private async _handleRequest(req: any, res: any, scheme: 'http' | 'https'): Promise<void> {
    const url = fullUrl(req, scheme);
    let target: URL;
    try {
      target = new URL(url);
    } catch (e: any) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('pbmockx: invalid request URL: ' + url);
      return;
    }

    // Refuse to proxy to ourselves (prevents an infinite loop when a proxy
    // config also proxies localhost).
    if (isLoopbackAddress(target.hostname) && Number(target.port || (target.protocol === 'https:' ? 443 : 80)) === this.config.port) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('pbmockx: refusing to proxy to itself (' + url + ')\n');
      return;
    }

    const id = this.nextId();
    const start = Date.now();
    const timings: any = { start };
    const reqTap = new BodyTap(this.config.capture.maxRecordBodyBytes);
    const ctx: ReqCtx = { id, url, rulesUrl: url, start, timings, req, res, method: req.method || 'GET', reqTap };

    const reqHeaders = normalizeHeaders(req.headers);
    const rec = this.store.upsert(id, {
      url,
      originalUrl: url,
      method: ctx.method,
      scheme: target.protocol.replace(':', ''),
      host: target.host,
      path: target.pathname + target.search,
      clientIp: req.socket && req.socket.remoteAddress,
      httpVersion: req.httpVersion,
      reqHeaders,
      timings,
    });
    this.events.broadcast('flow.new', flowSummary(rec));

    req.on('error', (e: any) => {
      this.store.upsert(id, { error: 'request stream error: ' + (e && e.message ? e.message : e) });
    });
    req.on('aborted', () => {
      this.store.upsert(id, { aborted: true });
      if (ctx.upstream) { try { ctx.upstream.destroy(); } catch {} }
    });

    // Request-phase rules.
    let plan;
    try {
      plan = await this.mock.planRequest(url);
    } catch (e: any) {
      plan = { matched: [], error: e.message };
    }
    if (plan.matched.length) this.store.upsert(id, { matchedRules: plan.matched });

    if (plan.localResponse) {
      // Start the tap only now: attaching 'data' early would put the request
      // into flowing mode while planRequest() awaits, silently dropping the
      // body before it can be piped upstream.
      this.startRequestTap(ctx, reqHeaders);
      const lr = plan.localResponse;
      const headers: Record<string, any> = {
        ...lr.headers,
        'content-length': String(lr.size != null ? lr.size : (lr.body ? lr.body.length : 0)),
      };
      if (lr.filePath) {
        // Stream large mocked files (APK/ZIP/PB) with recording sampled up to
        // the capture cap; never buffer the whole file per request.
        const tap = new BodyTap(this.config.capture.maxRecordBodyBytes);
        const stream = fs.createReadStream(lr.filePath);
        stream.on('data', (c: Buffer) => tap.push(c));
        stream.on('error', (e: any) => {
          log.warn('mock file stream failed:', lr.filePath, e.message);
          try { res.destroy(); } catch {}
          this.finalize(ctx, { status: lr.status, resHeaders: headers, error: 'mock file: ' + e.message });
        });
        stream.on('end', () => {
          const dec = decompressBody(tap.buffer(), getHeader(headers, 'content-encoding'));
          const info = detect(getHeader(headers, 'content-type'), dec.data);
          this.finalize(ctx, {
            status: lr.status,
            statusText: statusText(lr.status),
            resHeaders: headers,
            resBody: dec.data,
            resOriginalBody: dec.data,
            resInfo: info || undefined,
            mocked: true,
            matchedRules: plan.matched,
            resSize: lr.size || tap.total,
            resTruncated: tap.truncated || (!!lr.size && lr.size > tap.buffer().length),
          });
        });
        res.writeHead(lr.status, headers);
        stream.pipe(res);
        return;
      }
      const body = lr.body || Buffer.alloc(0);
      res.writeHead(lr.status, headers);
      res.end(body);
      const info = detect(getHeader(headers, 'content-type'), body);
      this.finalize(ctx, {
        status: lr.status,
        statusText: statusText(lr.status),
        resHeaders: headers,
        resBody: body,
        resOriginalBody: body,
        resInfo: info || undefined,
        mocked: true,
        matchedRules: plan.matched,
        resSize: body.length,
      });
      return;
    }

    if (plan.targetUrl) {
      target = new URL(plan.targetUrl);
      this.store.upsert(id, {
        url: target.href,
        host: target.host,
        path: target.pathname + target.search,
        scheme: target.protocol.replace(':', ''),
      });
    }

    const isHttps = target.protocol === 'https:';
    const targetHost = stripBrackets(target.hostname);
    const insecure =
      !this.config.proxy.upstreamTLS.rejectUnauthorized ||
      isPrivateHost(targetHost);
    const mod: any = isHttps ? https : http;
    const headers = requestHeaders(reqHeaders, target.host);
    const options: any = {
      protocol: target.protocol,
      hostname: targetHost,
      port: Number(target.port) || (isHttps ? 443 : 80),
      method: ctx.method,
      path: target.pathname + target.search,
      headers,
      agent: isHttps ? (insecure ? this.httpsInsecureAgent : this.httpsAgent) : this.httpAgent,
    };
    if (isHttps) {
      if (!isIpLiteral(targetHost)) options.servername = targetHost;
      options.rejectUnauthorized = !insecure;
    }

    timings.upstreamStart = Date.now();
    const upReq = mod.request(options, (upRes: any) => {
      this.onUpstreamResponse(ctx, upRes, target)
        .catch((e: any) => {
          log.error('response handling failed:', e && e.stack ? e.stack : e);
          try { res.destroy(e); } catch {}
          this.finalize(ctx, { error: 'response handling failed: ' + e.message });
        });
    });
    ctx.upstream = upReq;
    this.startRequestTap(ctx, reqHeaders);
    upReq.setTimeout(300000, () => upReq.destroy(new Error('upstream socket timeout')));
    upReq.on('error', (e: any) => {
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('pbmockx upstream error: ' + e.message + '\n');
        } catch {}
      } else {
        try { res.destroy(); } catch {}
      }
      this.finalize(ctx, { error: 'upstream: ' + e.message });
    });
    req.pipe(upReq);
  }

  private startRequestTap(ctx: ReqCtx, reqHeaders: Record<string, any>): void {
    if (ctx.tapStarted) return;
    ctx.tapStarted = true;
    ctx.req.on('data', (c: Buffer) => ctx.reqTap.push(c));
    ctx.req.on('end', () => this.finishRequestRecording(ctx, reqHeaders));
  }

  private finishRequestRecording(ctx: ReqCtx, reqHeaders: Record<string, any>): void {
    const ct = getHeader(reqHeaders, 'content-type');
    const encoding = getHeader(reqHeaders, 'content-encoding');
    const raw = ctx.reqTap.buffer();
    const dec = decompressBody(raw, encoding);
    const info = detect(ct, dec.data);
    this.store.upsert(ctx.id, {
      reqBody: dec.data,
      reqContentEncoding: encoding || undefined,
      reqSize: ctx.reqTap.total,
      reqTruncated: ctx.reqTap.truncated,
      reqInfo: info || undefined,
    });
  }

  private async onUpstreamResponse(ctx: ReqCtx, upRes: any, target: URL): Promise<void> {
    const headers = normalizeHeaders(upRes.headers);
    const status = upRes.statusCode || 502;
    const encoding = getHeader(headers, 'content-encoding');
    const ct = getHeader(headers, 'content-type');
    const proto = protocolFromCt(ct);
    const sse = isEventStream(headers);
    const earlyInfo = proto ? detect(ct, Buffer.alloc(0)) : null;

    ctx.timings.firstByte = Date.now();
    this.store.upsert(ctx.id, {
      status,
      statusText: statusText(status),
      resHeaders: headers,
      resInfo: earlyInfo || undefined,
      resContentEncoding: encoding || undefined,
    });

    const noBody = ctx.method === 'HEAD' || status === 204 || status === 304;
    const needsMock =
      !sse && !noBody && !!proto && this.mock.hasResponseRules(ctx.rulesUrl, proto);

    if (!needsMock) {
      this.passthrough(ctx, upRes, headers, status);
      return;
    }
    await this.mockResponse(ctx, upRes, headers, status, proto!, encoding, ct);
  }

  private passthrough(ctx: ReqCtx, upRes: any, headers: Record<string, any>, status: number): void {
    const tap = new BodyTap(this.config.capture.maxRecordBodyBytes);
    upRes.on('data', (c: Buffer) => tap.push(c));
    try {
      ctx.res.writeHead(status, responseHeaders(headers));
    } catch (e: any) {
      this.finalize(ctx, { error: 'writeHead failed: ' + e.message });
      try { upRes.destroy(); } catch {}
      return;
    }
    upRes.pipe(ctx.res);
    upRes.on('error', (e: any) => {
      try { ctx.res.destroy(); } catch {}
      this.finalize(ctx, { error: 'upstream response: ' + e.message });
    });
    ctx.res.on('close', () => {
      if (!ctx.res.writableEnded) {
        this.store.upsert(ctx.id, { aborted: true });
        try { upRes.destroy(); } catch {}
      }
    });
    upRes.on('end', () => {
      const encoding = getHeader(headers, 'content-encoding');
      const dec = decompressBody(tap.buffer(), encoding);
      const info = detect(getHeader(headers, 'content-type'), dec.data);
      this.finalize(ctx, {
        status,
        resHeaders: headers,
        resBody: dec.data,
        resOriginalBody: dec.data,
        resInfo: info || undefined,
        resSize: tap.total,
        resTruncated: tap.truncated,
      });
    });
  }

  private async mockResponse(
    ctx: ReqCtx,
    upRes: any,
    headers: Record<string, any>,
    status: number,
    proto: string,
    encoding: string,
    ct: string
  ): Promise<void> {
    const collected = await collectBody(upRes, this.config.capture.maxRewriteBodyBytes);
    if (collected.error === 'too-large') {
      // Too big to mock: stream what we already have, then the rest.
      try { ctx.res.writeHead(status, responseHeaders(headers)); } catch {}
      if (collected.body.length) ctx.res.write(collected.body);
      upRes.pipe(ctx.res);
      this.finalize(ctx, {
        status,
        resHeaders: headers,
        resSize: collected.total,
        resTruncated: true,
        error: 'response exceeds maxRewriteBodyBytes; not mocked',
      } as any);
      return;
    }
    if (collected.error) {
      this.finalize(ctx, { status, resHeaders: headers, error: 'response body read failed: ' + collected.error });
      try { ctx.res.destroy(); } catch {}
      return;
    }

    const raw = collected.body;
    const dec = decompressBody(raw, encoding);
    if (dec.error) {
      this.sendRaw(ctx, status, headers, raw, { decodeError: dec.error });
      return;
    }
    const info = detect(ct, dec.data);
    if (!info || (info.protocol !== 'json' && info.protocol !== 'protobuf')) {
      this.sendRaw(ctx, status, headers, raw, {});
      return;
    }

    let result;
    try {
      result = await this.mock.transformResponse(ctx.rulesUrl, info.protocol as any, info, dec.data);
    } catch (e: any) {
      this.sendRaw(ctx, status, headers, raw, { patchError: e.message });
      return;
    }
    if (!result || !result.patched) {
      this.sendRaw(ctx, status, headers, raw, {
        patchError: result && result.patchError,
        decodeError: result && result.decodeError,
        matchedRules: result && result.matched,
      }, info, dec.data);
      return;
    }

    const compressed = compressBody(result.body, encoding);
    let payload = result.body;
    let outHeaders: Record<string, any>;
    if (compressed.error) {
      outHeaders = responseHeaders(headers, { dropLength: true, dropEncoding: true });
    } else {
      payload = compressed.data;
      outHeaders = responseHeaders(headers, { dropLength: true });
    }
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) outHeaders[k.toLowerCase()] = v;
    }
    outHeaders['content-length'] = String(payload.length);
    const finalStatus = result.status || status;

    try {
      ctx.res.writeHead(finalStatus, outHeaders);
      ctx.res.end(payload);
    } catch (e: any) {
      this.finalize(ctx, { error: 'failed to send mocked response: ' + e.message });
      return;
    }
    this.finalize(ctx, {
      status: finalStatus,
      statusText: statusText(finalStatus),
      resHeaders: outHeaders,
      resBody: result.body,
      resOriginalBody: dec.data,
      resInfo: info,
      resPatched: true,
      mocked: true,
      matchedRules: result.matched,
      resSize: payload.length,
      patchError: result.patchError,
      decodeError: result.decodeError,
    });
  }

  private sendRaw(
    ctx: ReqCtx,
    status: number,
    headers: Record<string, any>,
    raw: Buffer,
    extra: any,
    info?: any,
    decoded?: Buffer
  ): void {
    try {
      ctx.res.writeHead(status, responseHeaders(headers));
      ctx.res.end(raw);
    } catch (e: any) {
      this.finalize(ctx, { error: 'failed to send response: ' + e.message });
      return;
    }
    const dec = decoded || decompressBody(raw, getHeader(headers, 'content-encoding')).data;
    this.finalize(ctx, {
      status,
      statusText: statusText(status),
      resHeaders: headers,
      resBody: dec,
      resOriginalBody: dec,
      resInfo: info || detect(getHeader(headers, 'content-type'), dec) || undefined,
      resSize: raw.length,
      ...extra,
    });
  }

  private finalize(ctx: ReqCtx, patch: any): void {
    ctx.timings.end = Date.now();
    const rec = this.store.upsert(ctx.id, {
      ...patch,
      timings: ctx.timings,
      durationMs: ctx.timings.end - ctx.start,
    });
    this.events.broadcast('flow.update', flowSummary(rec));
  }

  // --- CONNECT / TLS MITM ---

  handleConnect(req: any, clientSocket: any, head: Buffer): void {
    const socket = clientSocket as net.Socket;
    this.trackSocket(socket);
    let host: string;
    let port: number;
    try {
      const parsed = parseAuthority(req.url || '');
      host = parsed.host;
      port = parsed.port;
    } catch {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
      return;
    }

    const decision = this.mitmDecision(host, port);
    if (!decision.mitm) {
      this.rawTunnel(socket, host, port, head, decision.reason || 'bypass');
      return;
    }

    this.ca.getLeafPems(host).then((pems) => {
      if (socket.destroyed) return;
      socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: pbmockx\r\n\r\n');
      if (head && head.length) socket.unshift(head);

      const tlsServer = tls.createServer(
        { key: pems.key, cert: pems.cert, ALPNProtocols: ['http/1.1'] },
        (tlsSocket: tls.TLSSocket) => {
          tlsSocket.setTimeout(0);
          tlsSocket.on('error', (e: any) => log.debug('mitm socket error:', host, e.message));
          this.inner.emit('connection', tlsSocket);
        }
      );
      tlsServer.on('tlsClientError', (e: any, sock: any) => {
        log.debug('TLS handshake failed:', host, e && e.message);
        // Client rejected the CA, pinned a certificate, speaks mTLS, or the
        // bytes were never TLS at all. Record it: this is the "why do I see
        // no capture?" signal users need.
        this.recordTunnelFailure(host, port, socket, e, 'tls-handshake');
        try { sock.destroy(); } catch {}
      });
      tlsServer.on('error', (e: any) => log.debug('TLS server error:', host, e && e.message));
      this.tlsServers.add(tlsServer);
      socket.on('close', () => {
        this.tlsServers.delete(tlsServer);
        try { tlsServer.close(); } catch {}
      });
      tlsServer.emit('connection', socket);
    }).catch((e: any) => {
      log.warn('cannot create leaf cert for', host, e && e.message);
      this.recordTunnelFailure(host, port, socket, e, 'ca-error');
      try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      try { socket.destroy(); } catch {}
    });
  }

  /** A CONNECT that was intercepted but never became an HTTP flow. */
  private recordTunnelFailure(host: string, port: number, socket: any, e: any, reason: TunnelReason): void {
    if (this.config.proxy.recordTunnels === false) return;
    const authority = formatAuthority(host, port, true);
    const url = 'https://' + authority + '/';
    const start = Date.now();
    const detail = e && e.message ? e.message : 'unknown error';
    const rec = this.store.upsert(this.nextId(), {
      url,
      originalUrl: url,
      method: 'CONNECT',
      scheme: 'https',
      host: authority,
      path: '/',
      clientIp: socket && socket.remoteAddress,
      tunnel: reason,
      tunnelBytesUp: 0,
      tunnelBytesDown: 0,
      tunnelClose: 'error',
      error: (reason === 'tls-handshake' ? 'TLS handshake failed: ' : 'cannot issue leaf certificate: ') + detail,
      timings: { start, end: start },
      durationMs: 0,
    });
    this.events.broadcast('flow.new', flowSummary(rec));
  }

  /** Why a CONNECT is (not) intercepted — the reason ends up in the flow record. */
  private mitmDecision(host: string, port: number): { mitm: boolean; reason?: TunnelReason } {
    if (!this.config.proxy.mitm) return { mitm: false, reason: 'mitm-disabled' };
    if (matchesBypass(host, this.config.proxy.bypass || [])) return { mitm: false, reason: 'bypass' };
    const ports = this.config.proxy.mitmPorts || [];
    if (ports.length && !ports.includes(port)) return { mitm: false, reason: 'port' };
    return { mitm: true };
  }

  /**
   * Raw TCP tunnel for traffic pbmockx must not (or cannot) decrypt. The
   * plaintext is never touched, but the connection itself is recorded so
   * "nothing shows up in the UI" can be told apart from "the proxy is not
   * being used at all". Set `proxy.recordTunnels=false` to opt out.
   */
  private rawTunnel(socket: net.Socket, host: string, port: number, head: Buffer, reason: TunnelReason): void {
    const addr = formatAuthority(host, port);
    const record = this.config.proxy.recordTunnels !== false;
    const id = record ? this.nextId() : '';
    const timings: any = { start: Date.now() };
    if (record) {
      const rec = this.store.upsert(id, {
        url: 'tcp://' + addr,
        originalUrl: 'tcp://' + addr,
        method: 'CONNECT',
        scheme: 'tcp',
        host: addr,
        path: '',
        clientIp: socket.remoteAddress,
        tunnel: reason,
        tunnelBytesUp: head && head.length ? head.length : 0,
        tunnelBytesDown: 0,
        timings,
      });
      this.events.broadcast('flow.new', flowSummary(rec));
    }

    let bytesUp = head && head.length ? head.length : 0;
    let bytesDown = 0;
    let closeReason: TunnelClose = 'client';
    let errorText: string | undefined;
    let finished = false;
    let live = false;

    const patch = (): any => ({
      tunnelBytesUp: bytesUp,
      tunnelBytesDown: bytesDown,
      ...(errorText ? { error: errorText } : {}),
      timings,
    });

    // A tunnel can live for minutes (SSE/IM/long-poll); show bytes as soon as
    // they exist instead of leaving the row at 0 B until close.
    const showProgress = (): void => {
      if (!record || finished || live) return;
      live = true;
      this.events.broadcast('flow.update', flowSummary(this.store.upsert(id, patch())));
    };

    const finish = (): void => {
      if (!record || finished) return;
      finished = true;
      timings.end = Date.now();
      const rec = this.store.upsert(id, {
        ...patch(),
        tunnelClose: closeReason,
        durationMs: timings.end - timings.start,
      });
      this.events.broadcast('flow.update', flowSummary(rec));
    };

    const upstream = net.connect(port, host, () => {
      if (socket.destroyed) { upstream.destroy(); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: pbmockx\r\n\r\n');
      if (head && head.length) upstream.write(head);
      // Counters sit next to pipe() on purpose: attaching a data listener
      // earlier would put the socket in flowing mode and drop early bytes.
      socket.on('data', (c: Buffer) => { bytesUp += c.length; showProgress(); });
      upstream.on('data', (c: Buffer) => { bytesDown += c.length; showProgress(); });
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.trackSocket(upstream);
    upstream.on('error', (e: any) => {
      log.debug('tunnel failed:', host, port, e.message);
      closeReason = 'error';
      errorText = 'tunnel: ' + e.message;
      try {
        if (!socket.destroyed && !socket.writableEnded) {
          socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      } catch {}
      try { socket.destroy(); } catch {}
      finish();
    });
    socket.on('error', () => { try { upstream.destroy(); } catch {} });
    socket.on('close', () => { try { upstream.destroy(); } catch {} ; finish(); });
    upstream.on('close', () => {
      if (closeReason !== 'error') closeReason = 'upstream';
      try { socket.destroy(); } catch {}
      finish();
    });
  }

  // --- WebSocket / upgrade tunneling ---

  handleUpgrade(req: any, socket: any, head: Buffer, scheme: 'http' | 'https'): void {
    try {
      this.trackSocket(socket);
      const url = fullUrl(req, scheme);
      const target = new URL(url);
      const id = this.nextId();
      const start = Date.now();
      const reqHeaders = normalizeHeaders(req.headers);
      const rec: any = this.store.upsert(id, {
        url,
        originalUrl: url,
        method: req.method || 'GET',
        scheme: target.protocol.replace(':', ''),
        host: target.host,
        path: target.pathname + target.search,
        clientIp: req.socket && req.socket.remoteAddress,
        httpVersion: req.httpVersion,
        reqHeaders,
        upgrade: 'websocket',
        timings: { start },
      });
      this.events.broadcast('flow.new', flowSummary(rec));

      const isTls = target.protocol === 'https:';
      const port = Number(target.port) || (isTls ? 443 : 80);
      const targetHost = stripBrackets(target.hostname);
      const insecure =
        !this.config.proxy.upstreamTLS.rejectUnauthorized || isPrivateHost(targetHost);

      const headers = requestHeaders(reqHeaders, target.host);
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
      const lines = [`${req.method || 'GET'} ${target.pathname}${target.search} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
        else lines.push(`${k}: ${v}`);
      }
      lines.push('', '');
      const handshake = lines.join('\r\n');

      let bytesUp = 0;
      let bytesDown = 0;
      const onConnect = () => {
        up.write(handshake);
        if (head && head.length) up.write(head);
        socket.pipe(up);
        up.pipe(socket);
      };
      const onDataUpstream = (chunk: Buffer) => {
        bytesDown += chunk.length;
        if (rec.status == null) {
          const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(chunk.toString('latin1', 0, 64));
          if (m) {
            rec.status = parseInt(m[1], 10);
            this.events.broadcast('flow.update', flowSummary(rec));
          }
        }
      };
      const tlsOpts: any = { host: targetHost, port, rejectUnauthorized: !insecure };
      if (!isIpLiteral(targetHost)) tlsOpts.servername = targetHost;
      const up = isTls ? tls.connect(tlsOpts, onConnect) : net.connect(port, targetHost, onConnect);
      this.trackSocket(up as net.Socket);
      (up as any).on('data', onDataUpstream);
      socket.on('data', (chunk: Buffer) => { bytesUp += chunk.length; });
      (up as any).on('error', (e: any) => {
        log.debug('websocket upstream error:', e.message);
        try { socket.destroy(); } catch {}
        this.store.upsert(id, {
          status: 502,
          error: 'websocket upstream: ' + e.message,
          wsBytesUp: bytesUp,
          wsBytesDown: bytesDown,
          durationMs: Date.now() - start,
        });
      });
      const finish = () => {
        this.store.upsert(id, {
          wsBytesUp: bytesUp,
          wsBytesDown: bytesDown,
          durationMs: Date.now() - start,
          status: rec.status == null ? 101 : rec.status,
        });
        const saved = this.store.find(id);
        if (saved) this.events.broadcast('flow.update', flowSummary(saved));
      };
      socket.on('close', () => { try { (up as any).destroy(); } catch {} finish(); });
      (up as any).on('close', () => { try { socket.destroy(); } catch {} finish(); });
    } catch (e: any) {
      log.warn('upgrade failed:', e && e.message);
      try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    }
  }

  private trackSocket(socket: net.Socket): void {
    if (!socket) return;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
  }

  close(): void {
    for (const s of this.sockets) {
      try { s.destroy(); } catch {}
    }
    this.sockets.clear();
    for (const t of this.tlsServers) {
      try { t.close(); } catch {}
    }
    this.tlsServers.clear();
    try { this.inner.close(); } catch {}
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    this.httpsInsecureAgent.destroy();
  }
}
