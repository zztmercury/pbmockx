/**
 * End-to-end: HTTPS CONNECT MITM, patching over TLS, CA endpoints.
 */

import { test, before, after } from 'node:test';
import * as assert from 'assert';
import * as http from 'http';

import {
  httpsViaProxy,
  jsonApi,
  readCa,
  startHttpsUpstream,
  startTestDaemon,
  type TestDaemon,
} from '../helpers';

let d: TestDaemon;

before(async () => {
  d = await startTestDaemon({ config: { proxy: { mitmPorts: [] } } });
});

after(async () => {
  if (d) await d.stop();
});

async function reset(): Promise<void> {
  await jsonApi(d.port, '/flows', { method: 'DELETE' });
}

test('CONNECT MITM captures an HTTPS JSON response', async () => {
  await reset();
  const up = await startHttpsUpstream((req, res) => {
    const body = '{"secure":true,"path":"/x"}';
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  try {
    const r = await httpsViaProxy(d.port, '127.0.0.1', up.port, '/x', readCa(d.dir));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body.toString()), { secure: true, path: '/x' });

    const flows = await jsonApi(d.port, '/flows');
    assert.strictEqual(flows.length, 1);
    assert.ok(flows[0].url.startsWith('https://127.0.0.1:'));
    assert.strictEqual(flows[0].resProto, 'json');
    assert.strictEqual(flows[0].status, 200);

    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.deepStrictEqual(detail.resData, { secure: true, path: '/x' });
  } finally {
    await up.close();
  }
});

test('patch rules apply to HTTPS responses and keep the original', async () => {
  await reset();
  const up = await startHttpsUpstream((req, res) => {
    const body = JSON.stringify({ hello: 'tls', n: 1 });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  try {
    await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: { type: 'patch', url_pattern: `127.0.0.1:${up.port}/secure`, path: 'hello', value: 'mocked-tls' },
    });
    const r = await httpsViaProxy(d.port, '127.0.0.1', up.port, '/secure', readCa(d.dir));
    assert.deepStrictEqual(JSON.parse(r.body.toString()), { hello: 'mocked-tls', n: 1 });

    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.resData.hello, 'mocked-tls');
    assert.strictEqual(detail.resPatched, true);
    const orig = await jsonApi(d.port, `/flows/${flows[0].id}?original=1`);
    assert.strictEqual(orig.resData.hello, 'tls');
  } finally {
    await up.close();
  }
});

test('serves the CA certificate and info for device setup', async () => {
  const pem = await new Promise<string>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: d.port, path: '/__pbmockx/api/ca.pem' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(String(res.headers['content-type']).includes('pem'));
        resolve(Buffer.concat(chunks).toString());
      });
    }).on('error', reject);
  });
  assert.ok(pem.includes('BEGIN CERTIFICATE'));

  const info = await jsonApi(d.port, '/ca/info');
  assert.ok(/^([0-9A-F]{2}:)+[0-9A-F]{2}$/.test(info.fingerprint256));
  assert.ok(/^[0-9a-f]{8}$/.test(info.subjectHashOld));

  const legacy = await new Promise<string>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: d.port, path: '/cgi-bin/rootca' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
  assert.strictEqual(legacy, pem);
});
