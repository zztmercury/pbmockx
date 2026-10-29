/**
 * End-to-end: plain HTTP forward proxy, capture, JSON mock rules, CLI contract.
 */

import { test, before, after } from 'node:test';
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawn } from 'child_process';

import {
  jsonApi,
  proxyRequest,
  sleep,
  startTestDaemon,
  startUpstream,
  type TestDaemon,
} from '../helpers';
import { packageRoot } from '../../src/core/config';

let d: TestDaemon;

before(async () => {
  d = await startTestDaemon();
});

after(async () => {
  if (d) await d.stop();
});

async function reset(): Promise<void> {
  await jsonApi(d.port, '/flows', { method: 'DELETE' });
}

test('captures a JSON flow and decodes it', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ game: { name: 'TapTap', id: 7 } }));
  });
  try {
    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/api/game`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body.toString()), { game: { name: 'TapTap', id: 7 } });

    const flows = await jsonApi(d.port, '/flows');
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].method, 'GET');
    assert.strictEqual(flows[0].status, 200);
    assert.strictEqual(flows[0].resProto, 'json');
    assert.strictEqual(flows[0].hasReq, true);
    assert.strictEqual(flows[0].hasRes, true);

    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.deepStrictEqual(detail.resData, { game: { name: 'TapTap', id: 7 } });
    assert.strictEqual(detail.reqProtocol, undefined, 'GET has no request body/content-type');
    assert.strictEqual(detail.resProtocol, 'json');
  } finally {
    await up.close();
  }
});

test('patch rule changes the response and keeps the original', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ game: { name: 'Real', id: 7, tags: ['a'] } }));
  });
  try {
    const add = await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: { type: 'patch', url_pattern: `/api/game-${up.port}`, path: 'game.name', value: 'Mocked' },
    });
    assert.ok(add.ok);
    const add2 = await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: { type: 'patch', url_pattern: `/api/game-${up.port}`, path: 'game.tags', action: 'append', value: 'b' },
    });
    assert.ok(add2.ok);

    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/api/game-${up.port}`);
    const body = JSON.parse(r.body.toString());
    assert.strictEqual(body.game.name, 'Mocked');
    assert.deepStrictEqual(body.game.tags, ['a', 'b']);

    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.mocked, true);
    assert.strictEqual(detail.resPatched, true);
    assert.strictEqual(detail.resData.game.name, 'Mocked');
    assert.ok(detail.matchedRules.some((x: any) => x.outcome === 'applied'));

    const orig = await jsonApi(d.port, `/flows/${flows[0].id}?original=1`);
    assert.strictEqual(orig.resData.game.name, 'Real');
    assert.deepStrictEqual(orig.resData.game.tags, ['a']);
  } finally {
    await up.close();
  }
});

test('gzip response is decoded for patching and re-encoded for the client', async () => {
  await reset();
  const payload = JSON.stringify({ msg: 'hello', count: 1 });
  const gz = zlib.gzipSync(Buffer.from(payload));
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length });
    res.end(gz);
  });
  try {
    await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: { type: 'patch', url_pattern: `/gzip-${up.port}`, path: 'msg', value: 'patched' },
    });
    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/gzip-${up.port}`);
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(r.body).toString()), { msg: 'patched', count: 1 });

    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.resData.msg, 'patched');
    const orig = await jsonApi(d.port, `/flows/${flows[0].id}?original=1`);
    assert.strictEqual(orig.resData.msg, 'hello');
  } finally {
    await up.close();
  }
});

test('map_local(file) streams bytes with status and header overrides', async () => {
  await reset();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-file-'));
  const file = path.join(tmp, 'blob.bin');
  const bytes = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(file, bytes);
  try {
    const add = await jsonApi(d.port, '/map-local', {
      method: 'POST',
      body: {
        url_pattern: `/blob-${path.basename(tmp)}`,
        source: 'file',
        file_path: file,
        status: 201,
        headers: { 'x-mock': 'yes' },
      },
    });
    assert.ok(add.ok);
    const r = await proxyRequest(d.port, `http://127.0.0.1:9/blob-${path.basename(tmp)}`);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.headers['x-mock'], 'yes');
    assert.strictEqual(r.body.length, bytes.length);
    assert.strictEqual(crypto.createHash('sha256').update(r.body).digest('hex'), crypto.createHash('sha256').update(bytes).digest('hex'));

    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.mocked, true);
    assert.strictEqual(detail.status, 201);
    assert.strictEqual(detail.resSize, bytes.length);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('records a JSON POST request body', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ got: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  });
  try {
    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/api/post`, {
      method: 'POST',
      body: JSON.stringify({ hello: 'post' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.deepStrictEqual(JSON.parse(r.body.toString()), { got: { hello: 'post' } });
    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.reqProtocol, 'json');
    assert.deepStrictEqual(detail.reqData, { hello: 'post' });
  } finally {
    await up.close();
  }
});

test('large map_local file is streamed and recording is capped', async () => {
  await reset();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-bigfile-'));
  const file = path.join(tmp, 'big.bin');
  const bytes = crypto.randomBytes(5 * 1024 * 1024);
  fs.writeFileSync(file, bytes);
  try {
    await jsonApi(d.port, '/map-local', {
      method: 'POST',
      body: { url_pattern: `/big-${path.basename(tmp)}`, source: 'file', file_path: file },
    });
    const r = await proxyRequest(d.port, `http://127.0.0.1:9/big-${path.basename(tmp)}`);
    assert.strictEqual(r.body.length, bytes.length);
    assert.strictEqual(
      crypto.createHash('sha256').update(r.body).digest('hex'),
      crypto.createHash('sha256').update(bytes).digest('hex')
    );
    const flows = await jsonApi(d.port, '/flows');
    const detail = await jsonApi(d.port, `/flows/${flows[0].id}`);
    assert.strictEqual(detail.mocked, true);
    assert.strictEqual(detail.resSize, bytes.length);
    assert.strictEqual(detail.resTruncated, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('map_remote rewrites the target URL', async () => {
  await reset();
  const a = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'A', url: req.url }));
  });
  const b = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'B', url: req.url }));
  });
  try {
    await jsonApi(d.port, '/rules', {
      method: 'POST',
      body: {
        type: 'map_remote',
        url_pattern: `127.0.0.1:${a.port}/old`,
        replacement: `http://127.0.0.1:${b.port}/new`,
      },
    });
    const r = await proxyRequest(d.port, `http://127.0.0.1:${a.port}/old`);
    assert.deepStrictEqual(JSON.parse(r.body.toString()), { from: 'B', url: '/new' });

    const flows = await jsonApi(d.port, '/flows');
    assert.ok(flows[0].url.endsWith(`:${b.port}/new`));
    assert.ok(flows[0].originalUrl.endsWith(`:${a.port}/old`));
  } finally {
    await a.close();
    await b.close();
  }
});

test('SSE is streamed, never buffered', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    setTimeout(() => res.write('data: two\n\n'), 120);
    setTimeout(() => { res.write('data: three\n\n'); res.end(); }, 240);
  });
  try {
    const start = Date.now();
    let firstAt = 0;
    let endAt = 0;
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: d.port, method: 'GET',
        path: `http://127.0.0.1:${up.port}/events`,
        headers: { host: `127.0.0.1:${up.port}` },
      }, (res) => {
        assert.strictEqual(res.headers['content-type'], 'text/event-stream');
        let txt = '';
        res.on('data', (c: Buffer) => {
          if (!firstAt) firstAt = Date.now();
          txt += c.toString();
        });
        res.on('end', () => { endAt = Date.now(); resolve(txt); });
      });
      req.on('error', reject);
      req.end();
    });
    assert.ok(body.includes('data: one'));
    assert.strictEqual(endAt - start >= 200, true);
    assert.ok(firstAt - start < 200, `first SSE chunk arrived at ${firstAt - start}ms (stream buffered?)`);
    assert.ok(endAt - firstAt > 80);
    await sleep(50);
    const flows = await jsonApi(d.port, '/flows');
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].resProto, undefined);
  } finally {
    await up.close();
  }
});

test('large passthrough body is byte-identical', async () => {
  await reset();
  const data = crypto.randomBytes(2 * 1024 * 1024);
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    let off = 0;
    const tick = () => {
      if (off >= data.length) { res.end(); return; }
      const end = Math.min(off + 64 * 1024, data.length);
      res.write(data.subarray(off, end));
      off = end;
      setImmediate(tick);
    };
    tick();
  });
  try {
    const r = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/blob`);
    assert.strictEqual(r.body.length, data.length);
    assert.strictEqual(
      crypto.createHash('sha256').update(r.body).digest('hex'),
      crypto.createHash('sha256').update(data).digest('hex')
    );
    const flows = await jsonApi(d.port, '/flows');
    assert.strictEqual(flows[0].resSize, data.length);
  } finally {
    await up.close();
  }
});

test('HEAD and 204 responses are forwarded without a body', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    if (req.url === '/no-content') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 });
    res.end('{}');
  });
  try {
    const head = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/head`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.body.length, 0);
    const nc = await proxyRequest(d.port, `http://127.0.0.1:${up.port}/no-content`);
    assert.strictEqual(nc.status, 204);
    assert.strictEqual(nc.body.length, 0);
  } finally {
    await up.close();
  }
});

test('WebSocket upgrades are tunneled and recorded', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    res.writeHead(404);
    res.end('http only');
  });
  up.server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d: Buffer) => socket.write(d));
  });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(d.port, '127.0.0.1');
      let raw = Buffer.alloc(0);
      let upgraded = false;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('ws tunnel timeout')); }, 5000);
      socket.on('connect', () => {
        socket.write(
          `GET http://127.0.0.1:${up.port}/ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${up.port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      socket.on('data', (c: Buffer) => {
        raw = Buffer.concat([raw, c]);
        const text = raw.toString('latin1');
        if (!upgraded && text.includes('101 Switching Protocols')) {
          upgraded = true;
          socket.write('hello-through-ws');
        } else if (upgraded && text.includes('hello-through-ws')) {
          clearTimeout(timer);
          socket.destroy();
          resolve(text);
        }
      });
      socket.on('error', reject);
    });
    assert.ok(result.includes('101 Switching Protocols'));
    await sleep(100);
    const flows = await jsonApi(d.port, '/flows');
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].upgrade, 'websocket');
    assert.strictEqual(flows[0].status, 101);
  } finally {
    await up.close();
  }
});

test('CLI keeps its command contract against the native daemon', async () => {
  await reset();
  const up = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'cli' }));
  });
  const cli = path.join(packageRoot(), 'bin', 'pbmockx.js');
  // Async spawn is required: the daemon runs in this process, so a blocking
  // spawnSync would deadlock the HTTP request the CLI is making.
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, '--data-dir', d.dir, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PBMOCKX_LANG: 'en' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
  try {
    await proxyRequest(d.port, `http://127.0.0.1:${up.port}/api/cli`);
    const help = await run(['--help']);
    assert.strictEqual(help.status, 0);
    assert.ok(help.stdout.includes('Usage: pbmockx'));

    const flows = await run(['flows', '--json']);
    assert.strictEqual(flows.status, 0, flows.stderr);
    const list = JSON.parse(flows.stdout);
    assert.ok(Array.isArray(list) && list.length === 1);
    assert.ok(flows.stdout.includes('url'));

    const id = list[0].id;
    const decode = await run(['decode', id]);
    assert.strictEqual(decode.status, 0, decode.stderr);
    assert.ok(decode.stdout.includes('=== Response Body (JSON) ==='));
    assert.ok(decode.stdout.includes('"hello": "cli"'));

    const pathed = await run(['decode', id, '--path', 'hello']);
    assert.strictEqual(pathed.status, 0, pathed.stderr);
    assert.ok(pathed.stdout.includes('hello'));

    const add = await run(['rules', 'add', `/api/cli`, 'hello', 'patched', '--protocol', 'json']);
    assert.strictEqual(add.status, 0, add.stderr);
    assert.ok(add.stdout.includes('Rule added:'));

    const rules = await run(['rules', 'list', '--json']);
    assert.strictEqual(rules.status, 0, rules.stderr);
    assert.ok(JSON.parse(rules.stdout).some((r: any) => r.path === 'hello'));

    const status = await run(['status', '--json']);
    assert.strictEqual(status.status, 0, status.stderr);
    assert.strictEqual(JSON.parse(status.stdout).running, true);

    const doctor = await run(['doctor', '--json']);
    assert.strictEqual(doctor.status, 0, doctor.stderr);
    const djson = JSON.parse(doctor.stdout);
    assert.ok(djson.checks.some((c: any) => c.name === 'daemon' && c.status === 'OK'));
  } finally {
    await up.close();
  }
});
