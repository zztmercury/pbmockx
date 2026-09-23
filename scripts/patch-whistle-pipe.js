#!/usr/bin/env node
/**
 * Patch whistle lib/plugins/load-plugin.js — pipe CONNECT socket teardown.
 *
 * Two generations of the same class of bug (large responses through `pipe://`
 * intermittently losing tail bytes while still ending "cleanly"):
 *
 *  v1 (whistle <= 2.10.9): emitHttpPipe registered `socket.on('end',
 *      destroySocket)`; an incoming FIN destroyed the socket and RST'd
 *      unflushed outbound frames. Fix: drop that listener.
 *      Marker: pbmockx-pipe-end
 *
 *  v2 (whistle >= 2.10.10): upstream dropped the destroy-on-end listener and
 *      half-closes the socket directly in the encoder 'finish' listener:
 *
 *          encoder.once('finish', function () { socket.end(); });
 *
 *      `encoder.pipe(socket)` pauses the encoder whenever socket.write()
 *      returns false. The already-packed frames (including the `\n0\n`
 *      terminator) then sit in `encoder.readableLength`, and the synchronous
 *      socket.end() drops them: the peer's decoder pushes null on socket
 *      'end' regardless, so the client sees a clean chunked FIN at a frame
 *      boundary with a short body (whole 64KB frames missing). Reproduced
 *      with a plain passthrough of a 1.4MB body: 5/12 live runs truncated
 *      (e.g. 1245184/1413474); synthetic runs 7-10/20. Fix: resume the paused
 *      encoder and half-close only after encoder.readableLength and
 *      socket.writableLength are both zero. Verified 0 truncation across
 *      1.4MB/3.5MB/11.5MB sweeps plus mock/patch/map_local/POST/SSE
 *      regressions.
 *      Marker: pbmockx-pipe-flush
 *
 * Prints: already-patched | patched | upgraded | pattern-not-found
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) {
  console.log('pattern-not-found');
  process.exit(0);
}

const MARKER_V2 = 'pbmockx-pipe-flush';
const MARKER_V1 = 'pbmockx-pipe-end';
const s = fs.readFileSync(file, 'utf8');

if (s.includes(MARKER_V2) || s.includes(MARKER_V1)) {
  console.log('already-patched');
  process.exit(0);
}

const bak = file + '.pbmockx-pipe-bak';
const readFile = () => fs.readFileSync(file, 'utf8');
const ensureBackup = (from) => {
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, from);
};

// --- v2: defer half-close until the packed frames reached the socket ---
const ORIG_V2 = `            encoder.once('finish', function() {
              socket.end();
            });`;

const NEW_V2 = `            encoder.once('finish', function() {
              /* pbmockx-pipe-flush: encoder.pipe(socket) pauses the encoder
                 whenever socket.write() returns false; already-packed frames
                 (including the \\n0\\n terminator) then sit in
                 encoder.readableLength, and a synchronous socket.end() drops
                 them — the peer's decoder pushes null on socket 'end' and the
                 client sees a clean FIN at a frame boundary with a short body
                 (whole 64KB frames missing). Resume the paused encoder and
                 half-close only after every frame reached the socket. */
              var _pbmockxFlush = function () {
                if (socket.destroyed || socket.writableEnded) { return; }
                if (encoder.readableFlowing === false) { encoder.resume(); }
                if (encoder.readableLength === 0 && socket.writableLength === 0) {
                  socket.end();
                  return;
                }
                setImmediate(_pbmockxFlush);
              };
              setImmediate(_pbmockxFlush);
            });`;

// --- v1 (legacy, whistle <= 2.10.9): drop destroy-on-end ---
const ORIG_V1 = `            socket.pipe(decoder);
            encoder.pipe(socket);
            socket.on('end', destroySocket);
            httpServer.emit('request', decoder, encoder);`;
const NEW_V1 = `            socket.pipe(decoder);
            encoder.pipe(socket);
            // pbmockx-pipe-end: incoming FIN must not destroy(); encoder.pipe(socket) ends writable
            httpServer.emit('request', decoder, encoder);`;

function apply(orig, next) {
  const cur = readFile();
  if (cur.includes(orig)) {
    ensureBackup(cur);
    fs.writeFileSync(file, cur.replace(orig, next));
    console.log('patched');
    return true;
  }
  return false;
}

if (s.includes(ORIG_V2) && apply(ORIG_V2, NEW_V2)) {
  process.exit(0);
}
if (s.includes(ORIG_V1) && apply(ORIG_V1, NEW_V1)) {
  process.exit(0);
}

console.log('pattern-not-found');
