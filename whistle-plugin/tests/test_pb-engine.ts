/**
 * test_pb-engine.ts — unit tests for PBEngine, path-nav, rules.
 *
 * Run: node -e "require('./tests/test_pb-engine').run()"
 */

import * as assert from 'assert';
import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor';
import { PBEngine, DescCache } from '../src/pb-engine';
import { parsePath, setByPath, getByPath, appendByPath, insertByPath, removeByPath } from '../src/path-nav';
import { MockRule, RuleEngine } from '../src/rules';
import { isPb, isJson, isForm, parseForm, parseCtParams, detect } from '../src/content-type';
import { buildFieldTree, renderTree } from '../src/field-tree';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// --- android cert (cli.js helpers, require'd for testing) ---
const cli = require('../../bin/cli.js');
const testCertPem = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'test-cert.pem'), 'utf8');

// Build a demo.Person message type for testing
function buildDemoPerson(): { MsgType: protobuf.Type; encode: (data: any) => Buffer; descBytes: Buffer } {
  const root = protobuf.Root.fromJSON({
    nested: {
      demo: {
        nested: {
          Person: {
            fields: {
              name: { type: 'string', id: 1 },
              id: { type: 'int32', id: 2 },
            }
          }
        }
      }
    }
  });
  root.resolveAll();

  const MsgType = root.lookupType('demo.Person');
  const fds = (root as any).toDescriptor();
  const descExt = require('protobufjs/ext/descriptor');
  const descBytes = Buffer.from(descExt.FileDescriptorSet.encode(fds).finish());

  return {
    MsgType,
    descBytes,
    encode: (data: any) => Buffer.from(MsgType.encode(MsgType.create(data)).finish()),
  };
}

const tests: { name: string; fn: () => Promise<void> }[] = [];

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

// --- content-type tests ---

test('isPb detects protobuf content-type', () => {
  assert.ok(isPb('application/x-protobuf'));
  assert.ok(isPb('application/x-google-protobuf'));
  assert.ok(!isPb('application/json'));
  assert.ok(!isPb('text/html'));
  return Promise.resolve();
});

test('isJson detects json content-type', () => {
  assert.ok(isJson('application/json', Buffer.alloc(0)));
  assert.ok(isJson('application/json; charset=utf-8', Buffer.alloc(0)));
  assert.ok(isJson('text/plain', Buffer.from('{"a":1}')));
  assert.ok(!isJson('text/plain', Buffer.from('not json')));
  return Promise.resolve();
});

test('parseCtParams parses Charles self-describing format', () => {
  const ct = 'application/x-protobuf; desc="http://host/Model.desc"; messageType="demo.Person"; delimited=true';
  const params = parseCtParams(ct);
  assert.strictEqual(params.desc, 'http://host/Model.desc');
  assert.strictEqual(params.messageType, 'demo.Person');
  assert.strictEqual(params.delimited, true);

  const bare = 'application/x-protobuf; desc=http://host/M.desc; messageType=demo.M';
  const params2 = parseCtParams(bare);
  assert.strictEqual(params2.desc, 'http://host/M.desc');
  assert.strictEqual(params2.messageType, 'demo.M');
  assert.strictEqual(params2.delimited, false);
  return Promise.resolve();
});

test('detect identifies PB and JSON', () => {
  const pbInfo = detect('application/x-protobuf; desc="http://h/d.desc"; messageType="m.T"', Buffer.alloc(0));
  assert.strictEqual(pbInfo!.protocol, 'protobuf');
  assert.strictEqual(pbInfo!.desc, 'http://h/d.desc');

  const jsonInfo = detect('application/json', Buffer.from('{}'));
  assert.strictEqual(jsonInfo!.protocol, 'json');

  const none = detect('text/html', Buffer.from('<html>'));
  assert.strictEqual(none, null);
  return Promise.resolve();
});

test('isForm detects urlencoded content-type', () => {
  assert.ok(isForm('application/x-www-form-urlencoded'));
  assert.ok(isForm('application/x-www-form-urlencoded; charset=utf-8'));
  assert.ok(!isForm('application/json'));
  assert.ok(!isForm('multipart/form-data'));
  assert.ok(!isForm('application/x-protobuf'));
  assert.ok(!isForm(''));
  return Promise.resolve();
});

test('parseForm parses urlencoded body', () => {
  assert.deepStrictEqual(parseForm(Buffer.from('a=1&b=two')), { a: '1', b: 'two' });
  assert.deepStrictEqual(parseForm(Buffer.from('a=1&a=2&a=3')), { a: ['1', '2', '3'] });
  assert.deepStrictEqual(parseForm(Buffer.from('empty=')), { empty: '' });
  assert.deepStrictEqual(parseForm(Buffer.from('name=hello+world&x=%2B')), { name: 'hello world', x: '+' });
  assert.deepStrictEqual(parseForm(Buffer.from('')), {});
  return Promise.resolve();
});

test('detect identifies form content-type', () => {
  const formInfo = detect('application/x-www-form-urlencoded', Buffer.from('a=1'));
  assert.strictEqual(formInfo!.protocol, 'form');
  assert.strictEqual(formInfo!.delimited, false);
  // urlencoded body not misdetected as JSON
  const formInfo2 = detect('application/x-www-form-urlencoded', Buffer.from('a=1&b=2'));
  assert.strictEqual(formInfo2!.protocol, 'form');
  // PB/JSON priority unchanged
  assert.strictEqual(detect('application/x-protobuf; desc="http://h/d.desc"; messageType="m.T"', Buffer.alloc(0))!.protocol, 'protobuf');
  assert.strictEqual(detect('application/json', Buffer.from('{}'))!.protocol, 'json');
  assert.strictEqual(detect('text/html', Buffer.from('<html>')), null);
  return Promise.resolve();
});

// --- path-nav tests ---

test('parsePath parses dotted + indexed paths', () => {
  assert.deepStrictEqual(parsePath('a.b.c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(parsePath('a.b[0].c'), ['a', 'b', 0, 'c']);
  assert.deepStrictEqual(parsePath('[0][1]'), [0, 1]);
  return Promise.resolve();
});

test('getByPath/setByPath navigate objects', () => {
  const obj = { a: { b: [{ c: 1 }] } };
  assert.strictEqual(getByPath(obj, ['a', 'b', 0, 'c']), 1);
  setByPath(obj, ['a', 'b', 0, 'c'], 42);
  assert.strictEqual(obj.a.b[0].c, 42);
  return Promise.resolve();
});

test('appendByPath/insertByPath/removeByPath operate on repeated fields', () => {
  const obj = { list: [{ id: 1 }, { id: 3 }], tags: ['a', 'b'] };
  appendByPath(obj, ['tags'], 'c');
  assert.deepStrictEqual(obj.tags, ['a', 'b', 'c']);
  insertByPath(obj, ['list'], 1, { id: 2 });
  assert.deepStrictEqual(obj.list.map(x => x.id), [1, 2, 3]);
  removeByPath(obj, ['list'], 0);
  assert.deepStrictEqual(obj.list.map(x => x.id), [2, 3]);
  // remove out of range throws
  assert.throws(() => removeByPath(obj, ['list'], 99));
  // append to non-array throws
  assert.throws(() => appendByPath({ list: 1 }, ['list'], 'x'));
  return Promise.resolve();
});

// --- PBEngine tests ---

test('PBEngine decode/encode round-trip', async () => {
  const demo = buildDemoPerson();
  const descBytes = demo.descBytes;

  // Create a mock DescCache that returns our descBytes
  const mockCache = {
    get: async (url: string) => ({ bytes: descBytes, changed: true }),
  };
  const engine = new PBEngine(mockCache as any);

  const descUrl = 'test://demo.desc';
  const messageType = 'demo.Person';

  // Encode
  const original = { name: 'Alice', id: 42 };
  const encoded = await engine.encode(descUrl, messageType, false, original);

  // Decode
  const decoded = await engine.decode(descUrl, messageType, false, encoded);

  assert.strictEqual(decoded.name, 'Alice');
  assert.strictEqual(decoded.id, 42);
});

test('PBEngine delimited encode/decode', async () => {
  const demo = buildDemoPerson();
  const mockCache = { get: async () => ({ bytes: demo.descBytes, changed: true }) };
  const engine = new PBEngine(mockCache as any);

  const descUrl = 'test://demo.desc';
  const messageType = 'demo.Person';

  const items = [
    { name: 'Alice', id: 1 },
    { name: 'Bob', id: 2 },
  ];
  const encoded = await engine.encode(descUrl, messageType, true, items);
  const decoded = await engine.decode(descUrl, messageType, true, encoded);

  assert.strictEqual(Array.isArray(decoded), true);
  assert.strictEqual(decoded.length, 2);
  assert.strictEqual(decoded[0].name, 'Alice');
  assert.strictEqual(decoded[1].name, 'Bob');
});

// --- field-tree tests ---

test('buildFieldTree builds tree with type annotations', async () => {
  const demo = buildDemoPerson();
  const mockCache = { get: async () => ({ bytes: demo.descBytes, changed: true }) };
  const engine = new PBEngine(mockCache as any);

  const msg = await engine.decode('test://demo.desc', 'demo.Person', false,
    demo.encode({ name: 'TestName', id: 99 }));

  const tree = await buildFieldTree(msg, demo.MsgType) as any;
  assert.strictEqual(tree.messageType, 'demo.Person');
  assert.ok(tree.fields.length >= 2);

  const nameField = tree.fields.find((f: any) => f.name === 'name');
  assert.ok(nameField);
  assert.strictEqual(nameField!.type, 'string');
  assert.strictEqual(nameField!.value, 'TestName');

  const idField = tree.fields.find((f: any) => f.name === 'id');
  assert.ok(idField);
  assert.strictEqual(idField!.type, 'int32');
  assert.strictEqual(idField!.value, 99);
});

test('renderTree produces readable text', async () => {
  const demo = buildDemoPerson();
  const mockCache = { get: async () => ({ bytes: demo.descBytes, changed: true }) };
  const engine = new PBEngine(mockCache as any);

  const msg = await engine.decode('test://demo.desc', 'demo.Person', false,
    demo.encode({ name: 'Alice', id: 1 }));

  const tree = await buildFieldTree(msg, demo.MsgType) as any;
  const text = renderTree(tree);
  assert.ok(text.includes('demo.Person'));
  assert.ok(text.includes('name'));
  assert.ok(text.includes('Alice'));
  assert.ok(text.includes('(string)'));
});

// --- RuleEngine tests ---

test('RuleEngine add/dedup/delete', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const rulesFile = path.join(tmpDir, 'rules.yaml');
  const mockDir = path.join(tmpDir, 'mock-data');
  fs.mkdirSync(mockDir, { recursive: true });

  const engine = new RuleEngine(rulesFile, mockDir);

  // Add patch rule
  const r1 = new MockRule({ type: 'patch', url_pattern: 'api/test', path: 'name', value: 'Mocked', protocol: 'protobuf' });
  engine.add(r1);
  assert.strictEqual(engine.list().length, 1);

  // Dedup: same url + type + path → replace
  const r2 = new MockRule({ type: 'patch', url_pattern: 'api/test', path: 'name', value: 'Replaced' });
  engine.add(r2);
  assert.strictEqual(engine.list().length, 1);
  assert.strictEqual(engine.list()[0].value, 'Replaced');

  // Different path → new rule
  const r3 = new MockRule({ type: 'patch', url_pattern: 'api/test', path: 'id', value: 99 });
  engine.add(r3);
  assert.strictEqual(engine.list().length, 2);

  // Delete
  assert.ok(engine.delete(r2.id!));
  assert.strictEqual(engine.list().length, 1);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine matched filters by type/protocol', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const engine = new RuleEngine(path.join(tmpDir, 'rules.yaml'), path.join(tmpDir, 'mock-data'));

  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/test', path: 'name', value: 'x', protocol: 'protobuf' }));
  engine.add(new MockRule({ type: 'map_remote', url_pattern: 'api/old', replacement: 'https://new.com' }));

  const pbPatches = engine.matched('http://api/test', 'protobuf', 'patch');
  assert.strictEqual(pbPatches.length, 1);

  const remotes = engine.matched('http://api/old', undefined, 'map_remote');
  assert.strictEqual(remotes.length, 1);

  // Protocol filter: patch with protocol=json should not match protobuf
  const jsonPatches = engine.matched('http://api/test', 'json', 'patch');
  assert.strictEqual(jsonPatches.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine save/reload round-trip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const rulesFile = path.join(tmpDir, 'rules.yaml');
  const engine = new RuleEngine(rulesFile, path.join(tmpDir, 'mock-data'));

  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/x', path: 'name', value: 'test' }));
  engine.add(new MockRule({ type: 'map_remote', url_pattern: 'api/old', replacement: 'https://new.com' }));
  assert.ok(engine.save());

  const engine2 = new RuleEngine(rulesFile, path.join(tmpDir, 'mock-data'));
  const n = engine2.reload();
  assert.strictEqual(n, 2);
  assert.strictEqual(engine2.list().length, 2);

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine apply with repeated-field actions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const engine = new RuleEngine(path.join(tmpDir, 'rules.yaml'), path.join(tmpDir, 'mock-data'));

  const data = { items: [{ id: 1 }, { id: 3 }], tags: ['a', 'b'] };

  // append
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api', path: 'items', action: 'append', value: { id: 4 } }));
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api', path: 'tags', action: 'append', value: 'c' }));
  let r = engine.apply('http://api', 'json', data);
  assert.deepStrictEqual(r.items.map(x => x.id), [1, 3, 4]);
  assert.deepStrictEqual(r.tags, ['a', 'b', 'c']);

  // insert (inserts before index)
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api', path: 'items', action: 'insert', index: 1, value: { id: 2 } }));
  r = engine.apply('http://api', 'json', data);
  assert.deepStrictEqual(r.items.map(x => x.id), [1, 2, 3, 4]);

  // remove
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api', path: 'items', action: 'remove', index: 0 }));
  r = engine.apply('http://api', 'json', data);
  assert.deepStrictEqual(r.items.map(x => x.id), [2, 3, 4]);

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine append/remove round-trips through PB encode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const engine = new RuleEngine(path.join(tmpDir, 'rules.yaml'), path.join(tmpDir, 'mock-data'));

  // build a message type with a repeated message field
  const root = protobuf.Root.fromJSON({
    nested: {
      Item: { fields: { name: { type: 'string', id: 1 }, id: { type: 'int32', id: 2 } } },
      Resp: { fields: { items: { rule: 'repeated', type: 'Item', id: 1 } } },
    },
  });
  root.resolveAll();
  const Resp = root.lookupType('Resp');

  const msg = Resp.decode(Resp.encode({ items: [{ name: 'a', id: 1 }] }).finish());

  engine.add(new MockRule({ type: 'patch', url_pattern: 'api', path: 'items', action: 'append', value: { name: 'b', id: 2 } }));
  const patched = engine.apply('http://api', 'protobuf', msg);

  const back = Resp.decode(Resp.encode(patched).finish()) as any;
  assert.strictEqual(back.items.length, 2);
  assert.strictEqual(back.items[1].name, 'b');
  assert.strictEqual(back.items[1].id, 2);

  // remove index 0
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api', path: 'items', action: 'remove', index: 0 }));
  const patched2 = engine.apply('http://api', 'protobuf', msg);
  const back2 = Resp.decode(Resp.encode(patched2).finish()) as any;
  assert.strictEqual(back2.items.length, 1);
  assert.strictEqual(back2.items[0].name, 'b');

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

// --- android cert tests ---

test('subjectHashOld matches openssl subject_hash_old', () => {
  // fixture cert: openssl x509 -subject_hash_old = 64acf2b7
  const hash = cli.subjectHashOld(testCertPem);
  assert.strictEqual(hash, '64acf2b7');
  assert.ok(/^[0-9a-f]{8}$/.test(hash), 'hash should be 8 hex chars');
  return Promise.resolve();
});

test('classifyProxyState classifies proxy raw values', () => {
  const exp = '127.0.0.1:8899';
  assert.strictEqual(cli.classifyProxyState('127.0.0.1:8899', exp).state, 'ok');
  assert.strictEqual(cli.classifyProxyState('10.0.0.1:8080', exp).state, 'mismatch');
  assert.strictEqual(cli.classifyProxyState('null', exp).state, 'unset');
  assert.strictEqual(cli.classifyProxyState(':0', exp).state, 'unset');
  assert.strictEqual(cli.classifyProxyState('', exp).state, 'unset');
  assert.strictEqual(cli.classifyProxyState('  127.0.0.1:8899  ', exp).state, 'ok');
  return Promise.resolve();
});

test('classifyCertState classifies cert detection results', () => {
  const F = { found: true, ok: true };
  const NF = { found: false, ok: true };
  const D = { found: false, ok: true, denied: true };
  assert.strictEqual(cli.classifyCertState([F, NF], [NF]), 'system');
  assert.strictEqual(cli.classifyCertState([NF], [F, NF]), 'user');
  assert.strictEqual(cli.classifyCertState([NF], [NF]), 'not_found');
  assert.strictEqual(cli.classifyCertState([D], [D]), 'unknown');
  assert.strictEqual(cli.classifyCertState([F], [F]), 'system');
  return Promise.resolve();
});

test('parseDevices parses adb devices output', () => {
  // single device
  assert.deepStrictEqual(cli.parseDevices('List of devices attached\n12345\tdevice\n'), [{ serial: '12345', state: 'device' }]);
  // multiple devices
  assert.deepStrictEqual(cli.parseDevices('List of devices attached\n12345\tdevice\n67890\tdevice\n'), [{ serial: '12345', state: 'device' }, { serial: '67890', state: 'device' }]);
  // offline/unauthorized INCLUDED (with state) — needed to detect multi-device w/ offline
  assert.deepStrictEqual(cli.parseDevices('List of devices attached\n111\toffline\n222\tunauthorized\n333\tdevice\n'), [{ serial: '111', state: 'offline' }, { serial: '222', state: 'unauthorized' }, { serial: '333', state: 'device' }]);
  // single offline
  assert.deepStrictEqual(cli.parseDevices('List of devices attached\n111\toffline\n'), [{ serial: '111', state: 'offline' }]);
  // empty
  assert.deepStrictEqual(cli.parseDevices('List of devices attached\n'), []);
  assert.deepStrictEqual(cli.parseDevices(''), []);
  return Promise.resolve();
});

// --- Run ---

export async function run() {
  console.log('Running pbmockx tests...\n');
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (e: any) {
      console.error(`  [FAIL] ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  run();
}
