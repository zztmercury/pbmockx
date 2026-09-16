/**
 * Shared context — singletons for PBEngine, RuleEngine, FlowStore.
 *
 * All hooks (resRead, resWrite, reqRead, reqWrite, rulesServer, uiServer)
 * run in the same Node process, so module-level singletons work.
 */

import * as path from 'path';
import * as os from 'os';
import { PBEngine, DescCache } from './pb-engine';
import { RuleEngine } from './rules';
import { FlowStore } from './flow-store';

// Plugin root = dist/src/ is at __dirname, so plugin root is 2 levels up
const PLUGIN_ROOT = path.join(__dirname, '..', '..');
const RULES_FILE = path.join(PLUGIN_ROOT, 'rules.yaml');
const MOCK_DATA_DIR = path.join(PLUGIN_ROOT, 'mock-data');
// Desc disk cache — persists across w2 restart, avoids re-downloading multi-MB .desc
const DESC_CACHE_DIR = path.join(os.homedir(), '.pbmockx', 'desc-cache');

const descCache = new DescCache(DESC_CACHE_DIR);
const pbEngine = new PBEngine(descCache);
const rules = new RuleEngine(RULES_FILE, MOCK_DATA_DIR);
const flowStore = new FlowStore();

// Initialize: load rules from rules.yaml
let loaded = false;
function ensureInit() {
  if (loaded) return;
  const n = rules.reload();
  // Only latch success AFTER reload() returns, so a failed read is retried.
  loaded = true;
  if (n > 0) {
    console.log(`[pbmockx] loaded ${n} rules from rules.yaml`);
  }
}

// Eager init at module load: every hook imports this module, and the uiServer
// CGI path uses the `rules` singleton directly (never calling getContext()).
// Lazy init would leave an empty in-memory engine whose save() could then
// overwrite rules.yaml and delete every on-disk rule.
ensureInit();

// Kept for callers; idempotent and cheap once loaded.
export function getContext() {
  ensureInit();
  return { pbEngine, rules, flowStore, PLUGIN_ROOT, RULES_FILE, MOCK_DATA_DIR };
}

export { pbEngine, rules, flowStore, PLUGIN_ROOT, RULES_FILE, MOCK_DATA_DIR };
