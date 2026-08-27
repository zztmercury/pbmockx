#!/usr/bin/env node
/**
 * Patch whistle lib/https/h2.js (v2):
 *   - evict closed/destroyed sessions from the reuse cache
 *   - evict on session close after connect
 *   - on session-invalid errors: HTTP/1.1 fallback only if no body consumed;
 *     otherwise 502 (never replay a POST)
 *
 * Prints: already-patched | patched | pattern-not-found
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) {
  console.log('pattern-not-found');
  process.exit(0);
}

const MARKER = 'pbmockx-h2-session-v2';
let s = fs.readFileSync(file, 'utf8');
if (s.includes(MARKER)) {
  console.log('already-patched');
  process.exit(0);
}

const bak = file + '.pbmockx-h2-bak';
if (s.includes('pbmockx-h2-session') && fs.existsSync(bak)) {
  s = fs.readFileSync(bak, 'utf8');
}

const origLookup = `  if (client) {
    if (!reqId) {
      if (client.curIndex) {
        name = name + '\\n' + client.curIndex;
        client.curIndex = ++client.curIndex % CONCURRENT;
        client = clients[name];
      } else {
        client.curIndex = 1;
      }
    }
    if (client) {
      client._updateTime = Date.now();
      return requestH2(client, req, res, callback);
    }
  }`;

const newLookup = `  if (client && (client.closed || client.destroyed)) {
    // pbmockx-h2-session-v2: drop dead base session before slot selection
    try { client.close(); } catch (e) {}
    Object.keys(clients).forEach(function (k) { if (clients[k] === client) delete clients[k]; });
    client = null;
  }
  if (client) {
    if (!reqId) {
      if (client.curIndex) {
        name = name + '\\n' + client.curIndex;
        client.curIndex = ++client.curIndex % CONCURRENT;
        client = clients[name];
      } else {
        client.curIndex = 1;
      }
    }
    if (client && (client.closed || client.destroyed)) {
      try { client.close(); } catch (e) {}
      Object.keys(clients).forEach(function (k) { if (clients[k] === client) delete clients[k]; });
      client = null;
    }
    if (client) {
      client._updateTime = Date.now();
      return requestH2(client, req, res, callback);
    }
  }`;

const origClient = `  clients[name] = client;
  client._updateTime = Date.now();
  onClose(client, handleCallback);
  onClose(socket, handleCallback);
  return client;`;

const newClient = `  clients[name] = client;
  client._updateTime = Date.now();
  onClose(client, handleCallback);
  onClose(socket, handleCallback);
  client.once('close', function () {
    Object.keys(clients).forEach(function (k) { if (clients[k] === client) delete clients[k]; });
  });
  return client;`;

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
      var code = err && err.code;
      if (code !== 'ERR_HTTP2_INVALID_SESSION' && code !== 'ERR_HTTP2_SESSION_ERROR') return;
      try { client.close(); } catch (e) {}
      Object.keys(clients).forEach(function (k) { if (clients[k] === client) delete clients[k]; });
      if (req.noReqBody) {
        responsed = true;
        return callback();
      }
      responsed = true;
      try { h2Session.destroy(); } catch (e) {}
      if (res && typeof res.response === 'function') {
        res.response(util.wrapGatewayError(util.getErrorStack(err || 'Invalid HTTP/2 session')));
      }
    });
    onClose(h2Session, function() {`;

if (!s.includes(origLookup) || !s.includes(origClient) || !s.includes(origGuard) || !s.includes(origReq)) {
  console.log('pattern-not-found');
  process.exit(0);
}
if ((s.split(origLookup).length - 1) !== 1 ||
    (s.split(origClient).length - 1) !== 1 ||
    (s.split(origGuard).length - 1) !== 1 ||
    (s.split(origReq).length - 1) !== 1) {
  console.log('pattern-not-found');
  process.exit(0);
}

if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
s = s.replace(origLookup, newLookup)
  .replace(origClient, newClient)
  .replace(origGuard, newGuard)
  .replace(origReq, newReq);
fs.writeFileSync(file, s);
console.log('patched');
