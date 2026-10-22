/**
 * End-to-end: CONNECT tunnels that pbmockx does not decrypt must still show up
 * as metadata-only flows. This is what makes "no capture visible" diagnosable
 * (bypass vs. port vs. CA/handshake vs. proxy not used at all).
 */

import { test } from 'node:test';
import * as assert from 'assert';
import * as tls from 'tls';

import {
  connectTunnel,
  jsonApi,
  sleep,
  startHttpsUpstream,
  startTestDaemon,
  startUpstream,
  type TestDaemon,
} from '../helpers';

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for flow');
    await sleep(50);
  }
}

async function findByTunnel(d: TestDaemon, tunnel: string, requireClose = false): Promise<any> {
  return waitFor(async () => {
    const list = await jsonApi(d.port, '/flows');
    const f = (list || []).find((x: any) => x.tunnel === tunnel);
    if (!f) return null;
    return !requireClose || f.tunnelClose ? f : null;
  });
}

test('bypassed CONNECT is recorded as a metadata-only tunnel flow', async () => {
  const d = await startTestDaemon({ config: { proxy: { bypass: ['127.0.0.1'] } } });
  const up = await startHttpsUpstream((req, res) => {
    const body = 'through-tunnel-ok';
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  try {
    const socket = await connectTunnel(d.port, '127.0.0.1', up.port);
    const t = tls.connect({ socket, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      t.once('secureConnect', () => resolve());
      t.once('error', reject);
    });
    // Real TLS handshake against the upstream cert: pbmockx must stay out of it.
    t.write('GET /through-tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    await new Promise<void>((resolve) => {
      let raw = '';
      const done = () => resolve();
      t.on('data', (c: Buffer) => {
        raw += c.toString('latin1');
        if (raw.includes('through-tunnel-ok')) done();
      });
      t.on('end', done);
      t.on('error', done);
      setTimeout(done, 3000).unref?.();
    });
    t.destroy();
    socket.destroy();

    const flow = await findByTunnel(d, 'bypass', true);
    assert.strictEqual(flow.method, 'CONNECT');
    assert.strictEqual(flow.status, null);
    assert.strictEqual(flow.hasReq, false);
    assert.strictEqual(flow.hasRes, false);
    assert.strictEqual(flow.url, 'tcp://127.0.0.1:' + up.port);
    assert.deepStrictEqual(flow.reqProto, undefined);
    assert.strictEqual(flow.tunnel, 'bypass');
    assert.ok(flow.tunnelBytesUp > 0, 'bytes up should be counted');
    assert.ok(flow.tunnelBytesDown > 0, 'bytes down should be counted');

    const detail = await jsonApi(d.port, `/flows/${flow.id}`);
    assert.strictEqual(detail.tunnel, 'bypass');
    // Upstream sent `Connection: close`, so either side may close first.
    assert.ok(['client', 'upstream'].includes(detail.tunnelClose), 'close side: ' + detail.tunnelClose);
    assert.ok(detail.durationMs >= 0);
    assert.ok(detail.clientIp);

    // No plaintext must leak into the record.
    assert.strictEqual(detail.resData, undefined);
    assert.strictEqual(detail.reqData, undefined);
  } finally {
    await up.close();
    await d.stop();
  }
});

test('CONNECT outside proxy.mitmPorts is recorded with reason "port"', async () => {
  const d = await startTestDaemon({ config: { proxy: { mitm: true, mitmPorts: [443, 8443] } } });
  const up = await startUpstream((req, res) => res.end('plain'));
  try {
    const socket = await connectTunnel(d.port, '127.0.0.1', up.port);
    socket.destroy();

    const flow = await findByTunnel(d, 'port', true);
    assert.strictEqual(flow.url, 'tcp://127.0.0.1:' + up.port);
    assert.strictEqual(flow.tunnelClose, 'client');
  } finally {
    await up.close();
    await d.stop();
  }
});

test('failed TLS handshake is recorded so CA problems are visible', async () => {
  const d = await startTestDaemon({ config: { proxy: { mitm: true, mitmPorts: [] } } });
  const up = await startUpstream((req, res) => res.end('plain'));
  try {
    const socket = await connectTunnel(d.port, '127.0.0.1', up.port);
    socket.on('error', () => {});
    // Plaintext into a TLS server = what a mixed-up cert / non-TLS port looks like.
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');

    const flow = await findByTunnel(d, 'tls-handshake');
    assert.ok(/TLS handshake failed/.test(flow.error || ''), 'error should carry the handshake failure');
    assert.strictEqual(flow.method, 'CONNECT');
    assert.strictEqual(flow.tunnelClose, 'error');
    socket.destroy();
  } finally {
    await up.close();
    await d.stop();
  }
});

test('proxy.recordTunnels=false disables tunnel records', async () => {
  const d = await startTestDaemon({ config: { proxy: { bypass: ['127.0.0.1'], recordTunnels: false } } });
  const up = await startUpstream((req, res) => res.end('plain'));
  try {
    const socket = await connectTunnel(d.port, '127.0.0.1', up.port);
    socket.destroy();
    await sleep(300);
    const flows = await jsonApi(d.port, '/flows');
    assert.deepStrictEqual(flows, []);
  } finally {
    await up.close();
    await d.stop();
  }
});
