/**
 * test_pb-engine.ts — unit tests for PBEngine, path-nav, rules.
 *
 * Run: node -e "require('./tests/test_pb-engine').run()"
 */

import * as assert from 'assert';
import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor';
import { PBEngine, DescCache } from '../src/pb-engine';
import { parsePath, setByPath, getByPath, appendByPath, insertByPath, removeByPath, unsetByPath } from '../src/path-nav';
import { MockRule, RuleEngine } from '../src/rules';
import { isPb, isJson, isJsonCt, isJsonOrPbCt, isForm, isSse, parseForm, parseCtParams, detect, protocolFromCt } from '../src/content-type';
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

test('isJsonCt / isJsonOrPbCt / protocolFromCt are header-only', () => {
  assert.ok(isJsonCt('application/json'));
  assert.ok(isJsonCt('application/json; charset=utf-8'));
  assert.ok(!isJsonCt('text/plain'));
  assert.ok(!isJsonCt(''));
  assert.ok(isJsonOrPbCt({ 'content-type': 'application/json' }));
  assert.ok(isJsonOrPbCt({ 'Content-Type': 'application/x-protobuf' }));
  assert.ok(isJsonOrPbCt('application/x-google-protobuf'));
  assert.ok(!isJsonOrPbCt({ 'content-type': 'text/html' }));
  assert.ok(!isJsonOrPbCt({ accept: 'application/json' }));
  assert.ok(!isJsonOrPbCt(null));
  assert.strictEqual(protocolFromCt('application/json'), 'json');
  assert.strictEqual(protocolFromCt('application/x-protobuf; messageType=demo.T'), 'protobuf');
  assert.strictEqual(protocolFromCt('text/html'), undefined);
  assert.strictEqual(protocolFromCt(''), undefined);
  return Promise.resolve();
});

test('isSse detects text/event-stream in Content-Type or Accept', () => {
  assert.ok(isSse('text/event-stream'));
  assert.ok(isSse('text/event-stream; charset=utf-8'));
  assert.ok(isSse({ 'content-type': 'text/event-stream' }));
  assert.ok(isSse({ 'Content-Type': 'text/event-stream' }));
  assert.ok(isSse({ accept: 'text/event-stream' }));
  assert.ok(isSse({ Accept: 'text/html, text/event-stream' }));
  assert.ok(!isSse({ 'content-type': 'application/json' }));
  assert.ok(!isSse({ accept: 'application/json' }));
  assert.ok(!isSse('application/json'));
  assert.ok(!isSse(null));
  assert.ok(!isSse(''));
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

test('RuleEngine hasDataRules only matches patch / map_local(data)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const engine = new RuleEngine(path.join(tmpDir, 'rules.yaml'), path.join(tmpDir, 'mock-data'));

  assert.ok(!engine.hasDataRules('http://api/game', 'json'));

  engine.add(new MockRule({ type: 'map_remote', url_pattern: 'api/game', replacement: 'https://new.com' }));
  assert.ok(!engine.hasDataRules('http://api/game', 'json'));

  engine.add(new MockRule({ type: 'map_local', url_pattern: 'api/game', source: 'file', file_path: '/tmp/x.json' }));
  assert.ok(!engine.hasDataRules('http://api/game', 'json'));

  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/game', path: 'name', value: 'x', protocol: 'json' }));
  assert.ok(engine.hasDataRules('http://api/game', 'json'));
  assert.ok(!engine.hasDataRules('http://api/game', 'protobuf'));
  assert.ok(!engine.hasDataRules('http://other', 'json'));

  engine.add(new MockRule({ type: 'map_local', url_pattern: 'api/pb', source: 'data', data_file: 'x.json' }));
  assert.ok(engine.hasDataRules('http://api/pb', 'protobuf'));

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

test('RuleEngine save never clobbers an unread rules.yaml (data-loss regression)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const rulesFile = path.join(tmpDir, 'rules.yaml');
  const mockDir = path.join(tmpDir, 'mock-data');
  fs.mkdirSync(mockDir, { recursive: true });

  // 3 pre-existing rules on disk (as a plugin restart would find them).
  const initialYaml = [
    '- id: aaa11111',
    '  type: patch',
    '  url_pattern: api/one',
    '  path: name',
    '  value: one',
    '  protocol: json',
    '- id: bbb22222',
    '  type: patch',
    '  url_pattern: api/two',
    '  path: name',
    '  value: two',
    '- id: ccc33333',
    '  type: map_remote',
    '  url_pattern: api/old',
    '  replacement: https://new.com',
    '',
  ].join('\n');
  fs.writeFileSync(rulesFile, initialYaml, 'utf-8');

  // Deliberately do NOT reload() first — this is the exact bug: save() used to
  // serialize the empty in-memory list and wipe the 3 on-disk rules.
  const engine = new RuleEngine(rulesFile, mockDir);
  const added = engine.add(new MockRule({ type: 'patch', url_pattern: 'api/new', path: 'x', value: 1 }));
  assert.ok(engine.save(), 'save() should succeed after implicit reload');

  const check = new RuleEngine(rulesFile, mockDir);
  assert.strictEqual(check.reload(), 4, 'all 3 original rules plus the new one must remain');
  const ids = check.list().map(r => r.id);
  assert.ok(ids.includes('aaa11111'), 'original rule aaa11111 must survive');
  assert.ok(ids.includes('bbb22222'), 'original rule bbb22222 must survive');
  assert.ok(ids.includes('ccc33333'), 'original rule ccc33333 must survive');
  assert.ok(ids.includes(added.id), 'newly added rule must be present');

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine save refuses to clobber an unreadable rules.yaml', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const rulesFile = path.join(tmpDir, 'rules.yaml');

  // Unclosed YAML flow sequence — js-yaml throws on parse.
  const corrupt = 'rules: [1, 2,\n';
  fs.writeFileSync(rulesFile, corrupt, 'utf-8');
  const before = fs.readFileSync(rulesFile);

  const engine = new RuleEngine(rulesFile, path.join(tmpDir, 'mock-data'));
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/x', path: 'name', value: 'y' }));
  assert.strictEqual(engine.save(), false, 'save() must refuse when disk state is unknown');
  assert.deepStrictEqual(fs.readFileSync(rulesFile), before, 'file bytes must be untouched');

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine save works on a fresh install with no rules.yaml', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const rulesFile = path.join(tmpDir, 'rules.yaml');
  const mockDir = path.join(tmpDir, 'mock-data');

  const engine = new RuleEngine(rulesFile, mockDir);
  assert.strictEqual(engine.reload(), 0, 'no file → legitimate empty state');
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/fresh', path: 'name', value: 'z' }));
  assert.ok(engine.save(), 'save() must succeed on a fresh install');

  const check = new RuleEngine(rulesFile, mockDir);
  assert.strictEqual(check.reload(), 1);
  assert.strictEqual(check.list()[0].url_pattern, 'api/fresh');

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

// --- patch value: false/null + unset (toDict serialization fix) ---

test('RuleEngine toDict/save/reload preserves falsy values + unset action', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const rulesFile = path.join(tmpDir, 'rules.yaml');
  const engine = new RuleEngine(rulesFile, path.join(tmpDir, 'mock-data'));

  const cases: Array<{ path: string; value?: any; action?: any }> = [
    { path: 'a', value: false },
    { path: 'b', value: null },
    { path: 'c', value: 0 },
    { path: 'd', value: '' },
    { path: 'e', value: { k: 'v' } },
    { path: 'f', value: [1, 2] },
    { path: 'g', action: 'unset' },
  ];
  for (const c of cases) {
    engine.add(new MockRule({ type: 'patch', url_pattern: 'api/roundtrip', ...c }));
  }

  // toDict() via list() must not drop any of them
  const listed = engine.list();
  assert.strictEqual(listed.length, cases.length);
  const byPath = (arr: any[], p: string) => arr.find(r => r.path === p);
  assert.strictEqual(byPath(listed, 'a').value, false);
  assert.strictEqual(byPath(listed, 'b').value, null);
  assert.strictEqual(byPath(listed, 'c').value, 0);
  assert.strictEqual(byPath(listed, 'd').value, '');
  assert.strictEqual(byPath(listed, 'g').action, 'unset');
  // accepted consequence: false booleans now persist too
  assert.strictEqual(byPath(listed, 'a').delimited, false);
  assert.strictEqual(byPath(listed, 'a').is_regex, false);

  assert.ok(engine.save());

  const engine2 = new RuleEngine(rulesFile, path.join(tmpDir, 'mock-data'));
  assert.strictEqual(engine2.reload(), cases.length);
  const reloaded = engine2.list();
  assert.strictEqual(byPath(reloaded, 'a').value, false);
  assert.strictEqual(byPath(reloaded, 'b').value, null);
  assert.strictEqual(byPath(reloaded, 'c').value, 0);
  assert.strictEqual(byPath(reloaded, 'd').value, '');
  assert.deepStrictEqual(byPath(reloaded, 'e').value, { k: 'v' });
  assert.deepStrictEqual(byPath(reloaded, 'f').value, [1, 2]);
  assert.strictEqual(byPath(reloaded, 'g').action, 'unset');
  assert.strictEqual(byPath(reloaded, 'a').delimited, false);

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine apply: false/null kept, unset deletes key (JSON)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const engine = new RuleEngine(path.join(tmpDir, 'rules.yaml'), path.join(tmpDir, 'mock-data'));

  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/json', path: 'a', value: false }));
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/json', path: 'b', value: null }));
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/json', path: 'nested.x', action: 'unset' }));

  const data = { a: 1, b: 2, nested: { x: 1, y: 2 } };
  const r = engine.apply('http://api/json', 'json', data);

  assert.ok(Object.prototype.hasOwnProperty.call(r, 'a'));
  assert.strictEqual(r.a, false);
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'b'));
  assert.strictEqual(r.b, null);
  // unset removes the own property entirely
  assert.ok(!Object.prototype.hasOwnProperty.call(r.nested, 'x'));
  assert.strictEqual(r.nested.y, 2);

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('RuleEngine apply: bool false + unset round-trip through PB decode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-test-'));
  const engine = new RuleEngine(path.join(tmpDir, 'rules.yaml'), path.join(tmpDir, 'mock-data'));

  const root = protobuf.Root.fromJSON({
    nested: {
      FlagResp: { fields: { name: { type: 'string', id: 1 }, flag: { type: 'bool', id: 2 } } },
    },
  });
  root.resolveAll();
  const FlagResp = root.lookupType('FlagResp');

  const msg = FlagResp.decode(FlagResp.encode({ name: 'x', flag: true }).finish()) as any;
  assert.ok(Object.prototype.hasOwnProperty.call(msg, 'flag'));

  // patch flag=false keeps the field present (does NOT delete it)
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/pb', path: 'flag', value: false }));
  const patched = engine.apply('http://api/pb', 'protobuf', msg);
  const back = FlagResp.decode(FlagResp.encode(patched).finish()) as any;
  assert.ok(Object.prototype.hasOwnProperty.call(back, 'flag'));
  assert.strictEqual(back.flag, false);

  // unset removes the field — absent after decode
  engine.add(new MockRule({ type: 'patch', url_pattern: 'api/pb', path: 'name', action: 'unset' }));
  const patched2 = engine.apply('http://api/pb', 'protobuf', msg);
  const back2 = FlagResp.decode(FlagResp.encode(patched2).finish()) as any;
  assert.ok(!Object.prototype.hasOwnProperty.call(back2, 'name'));
  assert.strictEqual(back2.flag, false);

  fs.rmSync(tmpDir, { recursive: true });
  return Promise.resolve();
});

test('unsetByPath throws when parent path is missing', () => {
  const obj: any = { a: { b: 1 } };
  unsetByPath(obj, ['a', 'b']);
  assert.ok(!Object.prototype.hasOwnProperty.call(obj.a, 'b'));

  assert.throws(() => unsetByPath({ a: {} }, ['a', 'b', 'c']), /path not found: a\.b\.c/);
  assert.throws(() => unsetByPath({}, ['missing', 'x']), /path not found: missing\.x/);
  return Promise.resolve();
});

// --- CLI rules add: parsing + payload (unit) ---
// NOTE: the CLI module is already required at the top of this file as
//   const cli = require('../../bin/cli.js');
// which resolves from dist/tests/ → whistle-plugin/bin/cli.js. Requiring it is
// side-effect free (no stdout, no exit) — verified by the suite running at all.

test('CLI _buildPatchRule keeps false/null/0/"" as typed values', () => {
  const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  const rFalse = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', 'false']));
  assert.deepStrictEqual(rFalse, { type: 'patch', url_pattern: 'u', path: 'p', value: false });
  assert.ok(has(rFalse, 'value'), 'value key must exist for false (not dropped)');
  assert.strictEqual(rFalse.value, false);

  const rNull = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', 'null']));
  assert.ok(has(rNull, 'value'), 'value key must exist for null (not dropped)');
  assert.strictEqual(rNull.value, null);

  const rNeg = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '-1']));
  assert.strictEqual(rNeg.value, -1);
  assert.strictEqual(typeof rNeg.value, 'number', '-1 must not be swallowed as a flag nor left a string');

  const rZero = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '0']));
  assert.strictEqual(rZero.value, 0);

  const rEmpty = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '""']));
  assert.strictEqual(rEmpty.value, '');

  // argv-level empty string (`pbmockx rules add u p ''`): the RAW token is '' (falsy),
  // unlike the two-char '""' above. This is the one input where a truthiness guard on
  // parsed.value would silently drop the value, so it pins the `!== undefined` contract.
  const rEmptyArgv = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '']));
  assert.ok(has(rEmptyArgv, 'value'), 'argv-level empty string must not be dropped');
  assert.strictEqual(rEmptyArgv.value, '');

  const rObj = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '{"k":"v"}']));
  assert.deepStrictEqual(rObj.value, { k: 'v' });

  const rArr = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '[1,2]']));
  assert.deepStrictEqual(rArr.value, [1, 2]);

  return Promise.resolve();
});

test('CLI _buildPatchRule omits value for unset/remove and keeps action/index', () => {
  const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  const rUnset = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '--unset']));
  assert.deepStrictEqual(rUnset, { type: 'patch', url_pattern: 'u', path: 'p', action: 'unset' });
  assert.strictEqual(has(rUnset, 'value'), false, 'unset must not carry a value key');

  const rAppend = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '--append', '-2']));
  assert.deepStrictEqual(rAppend, { type: 'patch', url_pattern: 'u', path: 'p', action: 'append', value: -2 });

  const rInsert = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '--insert', '1', 'x']));
  assert.deepStrictEqual(rInsert, { type: 'patch', url_pattern: 'u', path: 'p', action: 'insert', index: 1, value: 'x' });

  // index 0 is falsy but must NOT be lost
  const rInsert0 = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '--insert', '0', 'null']));
  assert.deepStrictEqual(rInsert0, { type: 'patch', url_pattern: 'u', path: 'p', action: 'insert', index: 0, value: null });
  assert.strictEqual(rInsert0.index, 0);
  assert.strictEqual(rInsert0.value, null);

  const rRemove = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '--remove', '0']));
  assert.deepStrictEqual(rRemove, { type: 'patch', url_pattern: 'u', path: 'p', action: 'remove', index: 0 });
  assert.strictEqual(has(rRemove, 'value'), false, 'remove must not carry a value key');

  return Promise.resolve();
});

test('CLI _buildPatchRule maps --protocol pb and stays backward compatible', () => {
  const rProto = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'p', '--protocol', 'pb', 'v']));
  assert.strictEqual(rProto.protocol, 'protobuf');
  assert.strictEqual(rProto.value, 'v');

  const rCompat = cli._buildPatchRule(cli._parseRulesAddArgs(['api/game', 'game.name', 'TestName', '--protocol', 'pb']));
  assert.deepStrictEqual(rCompat, { type: 'patch', url_pattern: 'api/game', path: 'game.name', value: 'TestName', protocol: 'protobuf' });

  return Promise.resolve();
});

test('CLI rules add: value==path and path-substring-of-url parse correctly', () => {
  // old fragile delimiting (indexOf) could mis-split these
  const r1 = cli._buildPatchRule(cli._parseRulesAddArgs(['u', 'pathexample', 'pathexample']));
  assert.deepStrictEqual(r1, { type: 'patch', url_pattern: 'u', path: 'pathexample', value: 'pathexample' });

  const r2 = cli._buildPatchRule(cli._parseRulesAddArgs(['api/game/game', 'game', 'v']));
  assert.deepStrictEqual(r2, { type: 'patch', url_pattern: 'api/game/game', path: 'game', value: 'v' });

  return Promise.resolve();
});

test('CLI _parseValue JSON-parses with string fallback', () => {
  assert.strictEqual(cli._parseValue('false'), false);
  assert.strictEqual(cli._parseValue('null'), null);
  assert.strictEqual(cli._parseValue('-1'), -1);
  assert.strictEqual(cli._parseValue('0'), 0);
  assert.strictEqual(cli._parseValue('true'), true);
  assert.strictEqual(cli._parseValue('abc'), 'abc');
  assert.strictEqual(cli._parseValue(undefined), undefined);
  return Promise.resolve();
});

test('CLI _renderRuleValue renders unset/falsy/empty', () => {
  assert.strictEqual(cli._renderRuleValue({ action: 'unset' }), '(unset)');
  assert.strictEqual(cli._renderRuleValue({ value: false }), 'false');
  assert.strictEqual(cli._renderRuleValue({ value: null }), 'null');
  assert.strictEqual(cli._renderRuleValue({ value: 0 }), '0');
  assert.strictEqual(cli._renderRuleValue({ value: '' }), '""');
  assert.strictEqual(cli._renderRuleValue({}), '');
  // action wins over a present value
  assert.strictEqual(cli._renderRuleValue({ action: 'unset', value: false }), '(unset)');
  return Promise.resolve();
});

test('CLI rules add error paths exit 1 with a message (child process)', () => {
  const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
  const { spawnSync } = require('child_process');
  // _parseRulesAddArgs calls process.exit(1) on bad input, so it must run in a
  // child process — running it in-process would kill the test runner.
  const runArgs = (args: string[]) => spawnSync(process.execPath, [
    '-e',
    'const cli = require(' + JSON.stringify(cliPath) + ');'
      + 'const args = ' + JSON.stringify(args) + ';'
      + 'const parsed = cli._parseRulesAddArgs(args);'
      + 'process.stdout.write(JSON.stringify(cli._buildPatchRule(parsed)));',
  ], { encoding: 'utf-8' });

  const cases: Array<{ args: string[]; needle: string }> = [
    { args: ['u', 'p'], needle: 'missing <value>' },
    { args: ['u', 'p', '--bogus'], needle: 'unknown flag: --bogus' },
    { args: ['u', 'p', '--append'], needle: '--append requires a <value>' },
    { args: ['u', 'p', '--insert', '-1', 'x'], needle: '--insert requires a non-negative <idx>' },
    { args: ['u', 'p', '--insert', '1'], needle: '--insert requires a <value>' },
    { args: ['u', 'p', '--remove', 'x'], needle: '--remove requires a non-negative <idx>' },
    { args: ['u', 'p', '--append', '1', '--remove', '2'], needle: 'mutually exclusive' },
  ];
  for (const c of cases) {
    const r = runArgs(c.args);
    const err = String(r.stderr);
    assert.strictEqual(r.status, 1, 'expected exit 1 for ' + JSON.stringify(c.args) + ' (stderr: ' + err + ')');
    assert.ok(err.includes('Error: '), 'stderr must contain "Error: " for ' + JSON.stringify(c.args) + ' (got: ' + err + ')');
    assert.ok(err.includes(c.needle), 'stderr must contain "' + c.needle + '" for ' + JSON.stringify(c.args) + ' (got: ' + err + ')');
  }

  // happy path exits 0 — makes the status===1 assertions above meaningful
  const ok = runArgs(['u', 'p', 'false']);
  assert.strictEqual(ok.status, 0, 'happy path should exit 0 (stderr: ' + String(ok.stderr) + ')');
  assert.ok(String(ok.stdout).includes('"value":false'), 'happy path should serialize value:false, got: ' + String(ok.stdout));

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
  // 系统证书未找到 + 用户证书目录 denied → 无法判定（不能误报 not_found）
  assert.strictEqual(cli.classifyCertState([NF], [D]), 'unknown');
  // 任一目录探测失败（!ok）→ 无法判定
  assert.strictEqual(cli.classifyCertState([{ found: false, ok: false }], [NF]), 'unknown');
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
