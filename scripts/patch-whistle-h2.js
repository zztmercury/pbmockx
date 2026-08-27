#!/usr/bin/env node
/**
 * Patch whistle lib/https/h2.js:
 *   - skip closed/destroyed sessions in the reuse cache
 *   - on ERR_HTTP2_* stream errors, drop the cache entry and callback()
 *     so the request falls back to HTTP/1.1 instead of aborting the client
 *
 * Prints: already-patched | patched | pattern-not-found
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) {
  console.log('pattern-not-found');
  process.exit(0);
}
let s = fs.readFileSync(file, 'utf8');
if (s.includes('pbmockx-h2-session')) {
  console.log('already-patched');
  process.exit(0);
}

const origLookup = `    if (client) {
      client._updateTime = Date.now();
      return requestH2(client, req, res, callback);
    }`;
const newLookup = `    if (client) {
      // pbmockx-h2-session: skip closed sessions
      if (client.closed || client.destroyed) {
        try { client.close(); } catch (e) {}
        delete clients[name];
        client = null;
      } else {
        client._updateTime = Date.now();
        return requestH2(client, req, res, callback);
      }
    }`;

const origGuard = `function requestH2(client, req, res, callback) {
  if (req._hasError) {
    return;
  }`;
const newGuard = `function requestH2(client, req, res, callback) {
  if (req._hasError) {
    return;
  }
  if (client.closed || client.destroyed) {
    try { client.close(); } catch (e) {}
    Object.keys(clients).forEach(function (k) { if (clients[k] === client) delete clients[k]; });
    return callback();
  }`;

const origReq = `    var h2Session = client.request(headers, req.noReqBody ? REQ_OPTS : undefined);
    onClose(h2Session, function() {`;
const newReq = `    var h2Session = client.request(headers, req.noReqBody ? REQ_OPTS : undefined);
    h2Session.on('error', function (err) {
      if (responsed) return;
      if (err && typeof err.code === 'string' && err.code.indexOf('ERR_HTTP2_') === 0) {
        try { client.close(); } catch (e) {}
        Object.keys(clients).forEach(function (k) { if (clients[k] === client) delete clients[k]; });
        responsed = true;
        return callback();
      }
    });
    onClose(h2Session, function() {`;

if (!s.includes(origLookup) || !s.includes(origGuard) || !s.includes(origReq)) {
  console.log('pattern-not-found');
  process.exit(0);
}

const bak = file + '.pbmockx-h2-bak';
if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
s = s.replace(origLookup, newLookup).replace(origGuard, newGuard).replace(origReq, newReq);
fs.writeFileSync(file, s);
console.log('patched');
