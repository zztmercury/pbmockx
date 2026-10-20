/**
 * Shared helpers for integration tests: free ports, upstream servers,
 * proxy clients (plain HTTP and CONNECT/TLS) and a throwaway daemon.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';

import { startDaemon, type DaemonHandle } from '../src/server/daemon';

const forge: any = require('node-forge');

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
  });
}

export async function startUpstream(handler: any): Promise<{ port: number; server: http.Server; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    server,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      (server as any).closeAllConnections?.();
      setTimeout(r, 1000).unref();
    }),
  };
}

/** Self-signed cert for HTTPS upstream tests (never needs to be trusted). */
export function selfSignedPems(): { key: string; cert: string } {
  const kp = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  cert.sign(kp.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(kp.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

export async function startHttpsUpstream(handler: any): Promise<{ port: number; server: https.Server; close: () => Promise<void> }> {
  const pems = selfSignedPems();
  const server = https.createServer({ key: pems.key, cert: pems.cert }, handler);
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    server,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      (server as any).closeAllConnections?.();
      setTimeout(r, 1000).unref();
    }),
  };
}

export interface TestDaemon {
  handle: DaemonHandle;
  dir: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startTestDaemon(extra: any = {}): Promise<TestDaemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-e2e-'));
  const port = extra.port || (await freePort());
  const config = {
    proxy: { mitmPorts: [] },
    ...(extra.config || {}),
  };
  const handle = await startDaemon({ dataDir: dir, port, config });
  return {
    handle,
    dir,
    port: handle.port,
    stop: async () => {
      await handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ProxyResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function proxyRequest(
  proxyPort: number,
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}
): Promise<ProxyResult> {
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: options.method || 'GET',
        path: targetUrl,
        headers: { host: u.host, ...(options.headers || {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('proxy request timeout')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export function connectTunnel(proxyPort: number, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${host}:${port}` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error('CONNECT failed: ' + res.statusCode));
        socket.destroy();
        return;
      }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw HTTP/1.1 request over a CONNECT tunnel, trusting the pbmockx CA. */
export async function httpsViaProxy(
  proxyPort: number,
  host: string,
  port: number,
  requestPath: string,
  ca: string | Buffer,
  method = 'GET'
): Promise<ProxyResult> {
  const socket = await connectTunnel(proxyPort, host, port);
  const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({ socket, ca, checkServerIdentity: () => undefined }, () => resolve(s));
    s.on('error', reject);
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let raw: Buffer = Buffer.alloc(0);
    const finish = () => {
      const text = raw.toString('latin1');
      const idx = text.indexOf('\r\n\r\n');
      if (idx < 0) { reject(new Error('no response headers')); return; }
      const head = text.slice(0, idx).split('\r\n');
      const status = parseInt(head[0].split(' ')[1], 10);
      const headers: any = {};
      for (const line of head.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).toLowerCase().trim()] = line.slice(i + 1).trim();
      }
      let body = raw.subarray(Buffer.byteLength(text.slice(0, idx + 4), 'latin1'));
      if (String(headers['transfer-encoding'] || '').includes('chunked')) {
        body = dechunk(body);
      }
      resolve({ status, headers, body });
    };
    tlsSocket.on('data', (c: Buffer) => {
      raw = Buffer.concat([raw, c]);
      if (raw.includes('\r\n\r\n')) {
        const text = raw.toString('latin1');
        const idx = text.indexOf('\r\n\r\n');
        const headerPart = text.slice(0, idx);
        const m = /content-length:\s*(\d+)/i.exec(headerPart);
        if (m) {
          const bodyStart = Buffer.byteLength(text.slice(0, idx + 4), 'latin1');
          if (raw.length - bodyStart >= parseInt(m[1], 10)) finish();
        } else if (String(headerPart).includes('chunked')) {
          const body = raw.subarray(Buffer.byteLength(text.slice(0, idx + 4), 'latin1'));
          if (body.includes('\r\n0\r\n\r\n')) finish();
        }
      }
    });
    tlsSocket.on('end', finish);
    tlsSocket.on('error', reject);
    tlsSocket.write(`${method} ${requestPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => { try { tlsSocket.destroy(); } catch {} ; finish(); }, 10000).unref();
  });
}

function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    const size = parseInt(buf.subarray(pos, lineEnd).toString('latin1').trim(), 16);
    if (!size) break;
    const start = lineEnd + 2;
    out.push(buf.subarray(start, start + size));
    pos = start + size + 2;
  }
  return Buffer.concat(out);
}

export function readCa(dir: string): Buffer {
  return fs.readFileSync(path.join(dir, 'ca', 'ca.pem'));
}

export async function jsonApi(port: number, apiPath: string, options: { method?: string; body?: any } = {}): Promise<any> {
  const data = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/__pbmockx/api' + apiPath,
        method: options.method || 'GET',
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
