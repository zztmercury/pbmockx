/**
 * Unit tests for the new infrastructure: config, flow store bounds,
 * compression helpers, CA generation and request/response mock planning.
 */

import { test } from 'node:test';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {
  BodyTap,
  collectBody,
  compressBody,
  decompressBody,
  requestHeaders,
  responseHeaders,
  isEventStream,
} from '../../src/core/http-body';
import { FlowStore } from '../../src/core/flow-store';
import { RuleEngine, MockRule } from '../../src/core/rules';
import { MockEngine } from '../../src/mock/engine';
import { CertAuthority } from '../../src/proxy/ca';
import { loadConfig, paths, resolvePort, writeRuntime } from '../../src/core/config';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('FlowStore evicts by count and by total bytes', () => {
  const store = new FlowStore(2, 1024 * 1024);
  store.upsert('a', { url: 'http://a', method: 'GET', reqBody: Buffer.alloc(10) });
  store.upsert('b', { url: 'http://b', method: 'GET' });
  store.upsert('c', { url: 'http://c', method: 'GET' });
  assert.strictEqual(store.size(), 2);
  assert.strictEqual(store.find('a'), null);
  assert.ok(store.find('c'));

  const bytes = new FlowStore(10, 100);
  bytes.upsert('x', { url: 'http://x', method: 'GET', resBody: Buffer.alloc(80) });
  bytes.upsert('y', { url: 'http://y', method: 'GET', resBody: Buffer.alloc(80) });
  assert.strictEqual(bytes.size(), 1);
  assert.strictEqual(bytes.bytes(), 80);
  assert.ok(bytes.find('y'));
});

test('FlowStore upsert merges request and response into one record', () => {
  const store = new FlowStore();
  store.upsert('1', { url: 'http://x/1', method: 'GET', reqHeaders: { a: '1' }, timings: { start: 1 } });
  store.upsert('1', { status: 200, resHeaders: { 'content-type': 'application/json' } });
  const rec = store.find('1')!;
  assert.strictEqual(rec.status, 200);
  assert.ok(rec.hasReq);
  assert.ok(rec.hasRes);
  assert.deepStrictEqual(rec.reqHeaders, { a: '1' });
  assert.strictEqual(rec.timings!.start, 1);
});

test('gzip/deflate/br compression round-trips and reports bad input', () => {
  const raw = Buffer.from('{"hello":"world"}'.repeat(50));
  for (const enc of ['gzip', 'deflate', 'br', 'gzip, br']) {
    const c = compressBody(raw, enc);
    assert.ok(!c.error, enc + ' compress failed: ' + c.error);
    const d = decompressBody(c.data, enc);
    assert.ok(!d.error, enc + ' decompress failed: ' + d.error);
    assert.ok(d.data.equals(raw), enc + ' round trip must match');
  }
  const bad = decompressBody(Buffer.from('not-gzip'), 'gzip');
  assert.ok(bad.error);
  assert.ok(bad.data.equals(Buffer.from('not-gzip')), 'fallback returns original bytes');
});

test('BodyTap caps stored bytes and tracks truncation', () => {
  const tap = new BodyTap(10);
  tap.push(Buffer.alloc(4, 1));
  tap.push(Buffer.alloc(10, 2));
  assert.strictEqual(tap.total, 14);
  assert.strictEqual(tap.buffer().length, 10);
  assert.ok(tap.truncated);
});

test('collectBody aborts at the size cap without losing the error', async () => {
  const { Readable } = require('stream');
  const stream = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]);
  const r = await collectBody(stream, 10);
  assert.strictEqual(r.error, 'too-large');
  assert.strictEqual(r.total, 16);
  assert.strictEqual(r.body.length, 8, 'bytes received before the cap are kept');
});

test('header sanitization drops hop-by-hop headers but keeps cookies', () => {
  const req = requestHeaders({ host: 'old', connection: 'keep-alive', 'proxy-connection': 'x', accept: '*/*' }, 'new.example');
  assert.strictEqual(req.host, 'new.example');
  assert.strictEqual(req.connection, undefined);
  assert.strictEqual(req['proxy-connection'], undefined);
  assert.strictEqual(req.accept, '*/*');

  const res = responseHeaders({ 'content-length': '10', 'content-encoding': 'gzip', 'set-cookie': ['a=1', 'b=2'], connection: 'keep-alive' }, { dropLength: true });
  assert.strictEqual(res['content-length'], undefined);
  assert.strictEqual(res['content-encoding'], 'gzip');
  assert.deepStrictEqual(res['set-cookie'], ['a=1', 'b=2']);
  assert.strictEqual(res.connection, undefined);
  assert.ok(isEventStream({ 'content-type': 'text/event-stream' }));
});

test('CA generates a root and per-host leaf certificates with SANs', async () => {
  const dir = tmpDir('pbmockx-ca-');
  const ca = new CertAuthority(path.join(dir, 'ca'));
  await ca.ensure();
  const info = ca.info();
  assert.ok(/^[0-9a-f]{8}$/.test(info.subjectHashOld));
  assert.ok(info.fingerprint256.includes(':'));
  assert.ok(info.notAfter);

  const dns = await ca.getLeafPems('example.com');
  assert.ok(dns.cert.includes('BEGIN CERTIFICATE'));
  const dnsCert = require('node-forge').pki.certificateFromPem(dns.cert);
  assert.strictEqual(dnsCert.subject.getField('CN').value, 'example.com');
  const sanDns = dnsCert.getExtension('subjectAltName');
  assert.ok(sanDns.altNames.some((n: any) => n.type === 2 && n.value === 'example.com'));

  const ip = await ca.getLeafPems('127.0.0.1');
  const ipCert = require('node-forge').pki.certificateFromPem(ip.cert);
  const sanIp = ipCert.getExtension('subjectAltName');
  assert.ok(sanIp.altNames.some((n: any) => n.type === 7 && n.ip === '127.0.0.1'));

  // leaf cert verifies against the CA
  const verified = require('node-forge').pki.verifyCertificateChain(
    require('node-forge').pki.createCaStore([ca.getCaPem()]),
    [dnsCert]
  );
  assert.ok(verified);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('RuleEngine honours enabled=false and persists it', () => {
  const dir = tmpDir('pbmockx-rules-');
  const engine = new RuleEngine(path.join(dir, 'rules.yaml'), path.join(dir, 'mock-data'));
  const rule = new MockRule({ type: 'patch', url_pattern: 'api/x', path: 'a', value: 1 });
  engine.add(rule);
  assert.ok(engine.hasDataRules('http://h/api/x', 'json'));
  engine.setEnabled(rule.id, false);
  assert.ok(!engine.hasDataRules('http://h/api/x', 'json'));
  assert.strictEqual(engine.reload(), 1);
  const list = engine.list('patch');
  assert.strictEqual(list[0].enabled, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MockEngine normalizes map_remote targets and honours regex mode', async () => {
  const dir = tmpDir('pbmockx-mock-');
  fs.mkdirSync(path.join(dir, 'mock-data'), { recursive: true });
  const engine = new RuleEngine(path.join(dir, 'rules.yaml'), path.join(dir, 'mock-data'));
  engine.add(new MockRule({ type: 'map_remote', url_pattern: 'pub\\.xdrnd\\.cn/api/x', replacement: '127.0.0.1:9101/api/x' }));
  const mock = new MockEngine(engine, {} as any, path.join(dir, 'mock-data'));
  const plan = await mock.planRequest('https://pub.xdrnd.cn/api/x');
  assert.strictEqual(plan.targetUrl, 'https://127.0.0.1:9101/api/x');

  engine.add(new MockRule({ type: 'map_remote', url_pattern: '^https://old\\.example/old/(\\w+)$', replacement: 'https://new.example/$1', is_regex: true }));
  const plan2 = await mock.planRequest('https://old.example/old/thing');
  assert.strictEqual(plan2.targetUrl, 'https://new.example/thing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MockEngine applies JSON patch and map_local(data) with status/headers', async () => {
  const dir = tmpDir('pbmockx-mock2-');
  fs.mkdirSync(path.join(dir, 'mock-data'), { recursive: true });
  const engine = new RuleEngine(path.join(dir, 'rules.yaml'), path.join(dir, 'mock-data'));
  const mock = new MockEngine(engine, {} as any, path.join(dir, 'mock-data'));
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/json', path: 'game.name', value: 'Mocked' }));
  const info = { protocol: 'json' as const, delimited: false };
  const r = await mock.transformResponse('http://h/api/json', 'json', info, Buffer.from('{"game":{"name":"Real","id":7}}'));
  assert.ok(r && r.patched);
  assert.deepStrictEqual(JSON.parse(r!.body.toString()), { game: { name: 'Mocked', id: 7 } });

  engine.add(new MockRule({ type: 'map_local', url_pattern: 'api/local', source: 'data', data: { ok: true }, status: 201, headers: { 'x-mock': 'yes' } }));
  const r2 = await mock.transformResponse('http://h/api/local', 'json', info, Buffer.from('{"old":1}'));
  assert.ok(r2 && r2.patched);
  assert.deepStrictEqual(JSON.parse(r2!.body.toString()), { ok: true });
  assert.strictEqual(r2!.status, 201);
  assert.strictEqual(r2!.headers!['x-mock'], 'yes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MockEngine map_local(file) returns file bytes and content type', async () => {
  const dir = tmpDir('pbmockx-mock3-');
  fs.mkdirSync(path.join(dir, 'mock-data'), { recursive: true });
  const file = path.join(dir, 'mock.json');
  fs.writeFileSync(file, '{"file":true}');
  const engine = new RuleEngine(path.join(dir, 'rules.yaml'), path.join(dir, 'mock-data'));
  engine.add(new MockRule({ type: 'map_local', url_pattern: 'api/file', source: 'file', file_path: file, status: 202 }));
  const mock = new MockEngine(engine, {} as any, path.join(dir, 'mock-data'));
  const plan = await mock.planRequest('http://h/api/file');
  assert.ok(plan.localResponse);
  assert.strictEqual(plan.localResponse!.status, 202);
  assert.strictEqual(plan.localResponse!.headers['content-type'], 'application/json');
  assert.strictEqual(plan.localResponse!.body.toString(), '{"file":true}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config precedence and runtime port resolution', () => {
  const dir = tmpDir('pbmockx-config-');
  const p = paths(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p.configFile, JSON.stringify({ port: 9911, capture: { maxFlows: 7 } }));
  const cfg = loadConfig({ host: '0.0.0.0' }, p);
  assert.strictEqual(cfg.port, 9911);
  assert.strictEqual(cfg.capture.maxFlows, 7);
  assert.strictEqual(cfg.host, '0.0.0.0');
  assert.strictEqual(cfg.capture.maxRecordBodyBytes, 4 * 1024 * 1024);

  writeRuntime(p, { pid: 1, port: 9933, host: '127.0.0.1', version: 'x', startedAt: 1, dataDir: dir });
  assert.strictEqual(resolvePort(p), 9933);
  fs.rmSync(dir, { recursive: true, force: true });
});
