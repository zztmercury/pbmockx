/**
 * rulesServer — dynamically generates whistle native rules for
 * map_remote and map_local(file) from rules.yaml.
 *
 * These rule types use whistle's native URL-rewrite (https://) and
 * file-replace (file://) mechanisms, which are more efficient than
 * handling them in the plugin. The rulesServer translates structured
 * rules from rules.yaml into whistle rule text.
 *
 * Only fires for requests matching the plugin's custom protocol:
 *   pattern whistle.pbmockx://
 *   pattern pbmockx://
 *
 * NOTE: on whistle 2.10.x this hook is not invoked for ordinary HTTP traffic,
 * so the active path is native-rules.ts (direct CGI injection). Kept as-is for
 * compatibility with versions that do call it.
 */

import { rules } from './ctx';

export default (server: any, options: any) => {
  server.on('request', (req: any, res: any) => {
    // whistle waits on this response (16s timeout, several retries) before the
    // request can proceed — any throw that skips res.end() stalls the client.
    // Always answer, even on failure.
    try {
      const fullUrl = req.originalReq?.fullUrl || '';

      // Generate whistle native rules from rules.yaml
      const whistleRules = rules.toWhistleRules();

      // Pass all rules to whistle; it will match patterns itself
      res.end(whistleRules.join('\n'));
    } catch (e: any) {
      console.error('[pbmockx] rulesServer error:', e && e.message ? e.message : e);
      try { res.end(''); } catch {}
    }
  });
};
