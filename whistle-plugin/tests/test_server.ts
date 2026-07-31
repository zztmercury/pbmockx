/**
 * test_server.ts — mock HTTP server for E2E tests.
 *
 * Replaces the Python test_server.py — provides the same endpoints:
 *   GET /Model.desc    — returns FileDescriptorSet bytes (demo.Person)
 *   GET /api/person    — returns PB response with Charles self-describing Content-Type
 *   GET /api/data      — returns JSON response
 *
 * Uses protobufjs to build FileDescriptorSet dynamically (no .proto files).
 */

import * as http from 'http';
import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor';

const PORT = 8889;

// Build a FileDescriptorSet for demo.Person { string name = 1; int32 id = 2; }
function buildPersonDesc(): Buffer {
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
  const fds = (root as any).toDescriptor();
  const descExt = require('protobufjs/ext/descriptor');
  return Buffer.from(descExt.FileDescriptorSet.encode(fds).finish());
}

// Create a demo.Person message
function buildPerson(name: string, id: number): Buffer {
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
  const msg = MsgType.create({ name, id });
  return Buffer.from(MsgType.encode(msg).finish());
}

const descBytes = buildPersonDesc();

const server = http.createServer((req, res) => {
  if (req.url === '/Model.desc') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': descBytes.length,
    });
    res.end(descBytes);
    return;
  }

  if (req.url === '/api/person') {
    const personBytes = buildPerson('Alice', 42);
    const ct = `application/x-protobuf; desc="http://127.0.0.1:${PORT}/Model.desc"; messageType="demo.Person"`;
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': personBytes.length,
    });
    res.end(personBytes);
    return;
  }

  if (req.url === '/api/data') {
    const json = JSON.stringify({ game: { id: 1, name: 'TapTap' } });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
    return;
  }

  // POST endpoint for urlencoded body (E2E: reqRead form parsing)
  if (req.method === 'POST' && req.url === '/api/form') {
    req.on('data', () => {}); // drain
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

export function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[test_server] listening on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export { PORT, descBytes };

// Run directly
if (require.main === module) {
  startServer().then(() => {
    console.log('Press Ctrl+C to stop');
  });
}
