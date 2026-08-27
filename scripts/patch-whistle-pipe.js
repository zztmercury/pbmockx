#!/usr/bin/env node
/**
 * Patch whistle lib/plugins/load-plugin.js (v2):
 *   Do not destroy() the pipe CONNECT socket on incoming 'end'.
 *   encoder.pipe(socket) already ends the writable side when the encoder
 *   readable finishes; destroy() RSTs unflushed bytes.
 *
 * Prints: already-patched | patched | upgraded | pattern-not-found
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) {
  console.log('pattern-not-found');
  process.exit(0);
}

const MARKER = 'pbmockx-pipe-end';
let s = fs.readFileSync(file, 'utf8');
if (s.includes(MARKER) && !s.includes("[wpipe:")) {
  console.log('already-patched');
  process.exit(0);
}

const bak = file + '.pbmockx-pipe-bak';
const ORIG = `            socket.pipe(decoder);
            encoder.pipe(socket);
            socket.on('end', destroySocket);
            httpServer.emit('request', decoder, encoder);`;
const NEW = `            socket.pipe(decoder);
            encoder.pipe(socket);
            // pbmockx-pipe-end: incoming FIN must not destroy(); encoder.pipe(socket) ends writable
            httpServer.emit('request', decoder, encoder);`;

function apply(from, label) {
  if (!from.includes(ORIG) && from.includes(NEW)) {
    fs.writeFileSync(file, from);
    console.log(label);
    return true;
  }
  if ((from.split(ORIG).length - 1) !== 1) return false;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, from.replace(ORIG, NEW));
  console.log(label);
  return true;
}

if (s.includes(ORIG)) {
  if (apply(s, 'patched')) process.exit(0);
}

if (fs.existsSync(bak)) {
  const origFile = fs.readFileSync(bak, 'utf8');
  if (origFile.includes(ORIG) && apply(origFile, s.includes('[wpipe:') || s.includes('pbmockx-pipe') ? 'upgraded' : 'patched')) {
    process.exit(0);
  }
}

console.log('pattern-not-found');
