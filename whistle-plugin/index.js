/**
 * whistle.pbmockx — plugin entry point.
 *
 * Exports all hooks for whistle to load:
 *   resRead / resWrite / reqRead / reqWrite — pipe hooks
 *   rulesServer — dynamic whistle native rule generation (map_remote/map_local file)
 *   uiServer — Koa CGI server (rules CRUD + flow query + decode-pb)
 *
 * All hooks share the same Node process, so module-level singletons (ctx.ts)
 * provide the PBEngine, RuleEngine, and FlowStore instances.
 */

try {
  exports.resRead = require('./dist/src/resRead').default;
} catch (e) { console.error('[pbmockx] resRead load failed:', e.message); }

try {
  exports.resWrite = require('./dist/src/resWrite').default;
} catch (e) { console.error('[pbmockx] resWrite load failed:', e.message); }

try {
  exports.reqRead = require('./dist/src/reqRead').default;
} catch (e) { console.error('[pbmockx] reqRead load failed:', e.message); }

try {
  exports.reqWrite = require('./dist/src/reqWrite').default;
} catch (e) { console.error('[pbmockx] reqWrite load failed:', e.message); }

try {
  exports.rulesServer = require('./dist/src/rulesServer').default;
} catch (e) { console.error('[pbmockx] rulesServer load failed:', e.message); }

try {
  exports.uiServer = require('./dist/src/uiServer/index').default;
} catch (e) { console.error('[pbmockx] uiServer load failed:', e.message); }
