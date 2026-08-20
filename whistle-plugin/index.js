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

// 请求方向 pipe（reqRead/reqWrite）开关，默认启用（请求抓取/展示）。
//
// 注意：启用后 whistle 会删除请求的 Content-Length 并改用 chunked framing
// （见 whistle lib/inspectors/rules.js:188-192）；若后端/LB 对 chunked POST
// 处理有问题、出现「POST 偶发超时、GET 正常」，可置 false 禁用请求 pipe
// （只保留响应方向 resRead/resWrite），让 POST body 原样透传。
const ENABLE_REQ_PIPE = true;

if (ENABLE_REQ_PIPE) {
  try {
    exports.reqRead = require('./dist/src/reqRead').default;
  } catch (e) { console.error('[pbmockx] reqRead load failed:', e.message); }

  try {
    exports.reqWrite = require('./dist/src/reqWrite').default;
  } catch (e) { console.error('[pbmockx] reqWrite load failed:', e.message); }
}

try {
  exports.rulesServer = require('./dist/src/rulesServer').default;
} catch (e) { console.error('[pbmockx] rulesServer load failed:', e.message); }

try {
  exports.uiServer = require('./dist/src/uiServer/index').default;
} catch (e) { console.error('[pbmockx] uiServer load failed:', e.message); }
