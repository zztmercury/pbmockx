/**
 * End-to-end: protobuf response decode, field-tree detail, patch + original.
 */

import { test, before, after } from 'node:test';
import * as assert from 'assert';
import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor';

import { jsonApi, proxyRequest, startTestDaemon, startUpstream, type TestDaemon } from '../helpers';
import type { MessageTree } from '../../src/core/field-tree';

let d: TestDaemon;

function buildPerson(): { desc: Buffer; encode: (v: any) => Buffer } {
  const root = protobuf.Root.fromJSON({
    nested: {
      demo: {
        nested: {
          Person: {
            fields: {
              name: { type: 'string', id: 1 },
              id: { type: 'int32', id: 2 },
              tags: { rule: 'repeated', type: 'string', id: 3 },
              address: { type: 'string', id: 4 },
            },
          },
        },
      },
    },
  });
  root.resolveAll();
  const T = root.lookupType('demo.Person');
  const desc = Buffer.from((require('protobufjs/ext/descriptor').FileDescriptorSet.encode((root as any).toDescriptor()).finish()));
  return {
    desc,
    encode: (v: any) => Buffer.from(T.encode(T.create(v)).finish()),
  };
}

function field(tree: MessageTree | MessageTree[], name: string): any {
  const t = Array.isArray(tree) ? tree[0] : tree;
  return t.fields.find((f) => f.name === name);
}

before(async () => {
  d = await startTestDaemon();
});

after(async () => {
  if (d) await d.stop();
});

test('decodes PB, exposes a typed field tree, patches and keeps original', async () => {
  await jsonApi(d.port, '/flows', { method: 'DELETE' });
  const person = buildPerson();
  const up = await startUpstream((req, res) => {
    if (req.url === '/Model.desc') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': person.desc.length });
      res.end(person.desc);
      return;
    }
    const body = person.encode({ name: 'Alice', id: 42, tags: ['a', 'b'] });
    const ct = `application/x-protobuf; desc="http://127.0.0.1:${upPort}/Model.desc"; messageType="demo.Person"`;
    res.writeHead(200, { 'content-type': ct, 'content-length': body.length });
    res.end(body);
  });
  const upPort = up.port;
  try {
    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/api/person`);
    assert.strictEqual(r.status, 200);

    let flows = await jsonApi(d.port, '/flows');
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].resProto, 'protobuf');
    assert.strictEqual(flows[0].resMessageType, 'demo.Person');

    let detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.resProtocol, 'protobuf');
    assert.strictEqual(detail.resMessageType, 'demo.Person');
    assert.strictEqual(field(detail.resData, 'name').value, 'Alice');
    assert.strictEqual(field(detail.resData, 'id').value, 42);
    assert.strictEqual(field(detail.resData, 'id').type, 'int32');
    assert.strictEqual(field(detail.resData, 'tags').kind, 'repeated');
    assert.deepStrictEqual(field(detail.resData, 'tags').items.map((x: any) => x.value), ['a', 'b']);

    await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: { type: 'patch', url_pattern: `127.0.0.1:${up.port}/api/person`, path: 'name', value: 'Bob', protocol: 'protobuf' },
    });
    const r2 = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/api/person`);
    assert.strictEqual(r2.status, 200);

    flows = await jsonApi(d.port, '/flows');
    const id = flows.find((f: any) => f.mocked)?.id || flows[0].id;
    detail = await jsonApi(d.port, `/flows/${id}`);
    assert.strictEqual(detail.resPatched, true);
    assert.strictEqual(field(detail.resData, 'name').value, 'Bob');

    const orig = await jsonApi(d.port, `/flows/${id}?original=1`);
    assert.strictEqual(field(orig.resData, 'name').value, 'Alice');

    // The returned bytes must also decode back to the patched value.
    const root = protobuf.Root.fromJSON({
      nested: {
        demo: {
          nested: {
            Person: {
              fields: {
                name: { type: 'string', id: 1 },
                id: { type: 'int32', id: 2 },
                tags: { rule: 'repeated', type: 'string', id: 3 },
                address: { type: 'string', id: 4 },
              },
            },
          },
        },
      },
    });
    root.resolveAll();
    const T = root.lookupType('demo.Person');
    const back = T.decode(r2.body) as any;
    assert.strictEqual(back.name, 'Bob');
    assert.strictEqual(back.id, 42);
    assert.deepStrictEqual(back.tags, ['a', 'b']);
  } finally {
    await up.close();
  }
});

test('patch failure passes the original body through and records patch_error', async () => {
  await jsonApi(d.port, '/flows', { method: 'DELETE' });
  const person = buildPerson();
  const up = await startUpstream((req, res) => {
    if (req.url === '/Model.desc') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(person.desc);
      return;
    }
    const body = person.encode({ name: 'Carol', id: 7 });
    const ct = `application/x-protobuf; desc="http://127.0.0.1:${up.port}/Model.desc"; messageType="demo.Person"`;
    res.writeHead(200, { 'content-type': ct, 'content-length': body.length });
    res.end(body);
  });
  try {
    // Removing an out-of-range index makes the patch throw before encoding.
    await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: { type: 'patch', url_pattern: `127.0.0.1:${up.port}/bad`, path: 'tags', action: 'remove', index: 99 },
    });
    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/bad`);
    assert.strictEqual(r.status, 200);
    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.ok(detail.patchError, 'patch error must be recorded');
    assert.strictEqual(field(detail.resData, 'name').value, 'Carol');
  } finally {
    await up.close();
  }
});
