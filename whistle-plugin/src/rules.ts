/**
 * MockRule + RuleEngine — unified rule model for patch + map_local(data) +
 * map_local(file) + map_remote.
 *
 * - patch / map_local(data): applied in pipe resRead only (need PB encode)
 * - map_local(file) / map_remote: translated to whistle native rules by rulesServer
 *
 * rules.yaml stores all rules. map_local(data) uses data_file reference to
 * external mock-data/<id>.json to keep rules.yaml compact.
 *
 * Replicates Python pbmockx_addon.py MockRule + MockEngine (lines 304-453).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { parsePath, setByPath, appendByPath, insertByPath, removeByPath, unsetByPath, type PathSegment } from './path-nav';
import type { Protocol } from './content-type';

export type RuleType = 'patch' | 'map_local' | 'map_remote';

/** Patch operation: set (default, replace whole field) | append | insert | remove | unset. */
export type PatchAction = 'set' | 'append' | 'insert' | 'remove' | 'unset';

export interface MockRuleData {
  id?: string;
  type: RuleType;
  url_pattern: string;
  // patch
  path?: string;
  value?: any;
  protocol?: Protocol;
  // patch on repeated fields
  action?: PatchAction;
  index?: number;
  // map_local
  source?: 'file' | 'data';
  data_file?: string;
  file_path?: string;
  data?: any;
  desc?: string;
  messageType?: string;
  delimited?: boolean;
  status?: number;
  headers?: Record<string, string>;
  // map_remote
  replacement?: string;
  is_regex?: boolean;
}

export class MockRule {
  id: string;
  type: RuleType;
  urlPattern: string;
  // patch
  path?: string;
  value?: any;
  protocol?: Protocol;
  action?: PatchAction;
  index?: number;
  // map_local
  source?: 'file' | 'data';
  dataFile?: string;
  filePath?: string;
  desc?: string;
  messageType?: string;
  delimited?: boolean;
  status?: number;
  headers?: Record<string, string>;
  // map_remote
  replacement?: string;
  isRegex?: boolean;
  data?: any;  // inline mock data (when source='data' and no data_file)

  constructor(data: MockRuleData) {
    this.id = data.id || crypto.randomBytes(4).toString('hex');
    this.type = data.type;
    this.urlPattern = data.url_pattern;
    this.path = data.path;
    this.value = data.value;
    this.protocol = data.protocol;
    this.action = data.action || 'set';
    this.index = data.index;
    this.source = data.source || 'file';
    this.dataFile = data.data_file;
    this.filePath = data.file_path;
    this.desc = data.desc;
    this.messageType = data.messageType;
    this.delimited = data.delimited ?? false;
    this.status = data.status;
    this.headers = data.headers;
    this.replacement = data.replacement;
    this.isRegex = data.is_regex ?? false;
    this.data = data.data;
  }

  toDict(): MockRuleData {
    const d: MockRuleData = {
      id: this.id,
      type: this.type,
      url_pattern: this.urlPattern,
    };
    for (const [k, v] of Object.entries({
      path: this.path,
      value: this.value,
      protocol: this.protocol,
      action: this.action === 'set' ? undefined : this.action,
      index: this.index,
      source: this.source,
      data_file: this.dataFile,
      file_path: this.filePath,
      desc: this.desc,
      messageType: this.messageType,
      delimited: this.delimited,
      status: this.status,
      headers: this.headers,
      replacement: this.replacement,
      is_regex: this.isRegex,
    })) {
      if (v !== undefined) {
        (d as any)[k] = v;
      }
    }
    return d;
  }

  matches(url: string, protocol?: Protocol): boolean {
    if (this.protocol && this.protocol !== protocol) return false;
    // Use regex search (same as Python: re.search)
    try {
      const re = new RegExp(this.urlPattern);
      return re.test(url);
    } catch {
      return url.includes(this.urlPattern);
    }
  }
}

export class RuleEngine {
  private rules: MockRule[] = [];
  private rulesFile: string;
  private mockDataDir: string;
  /**
   * True only once reload() has genuinely established disk state (file read +
   * parsed, or a confirmed "no rules file yet"). save() refuses to write until
   * then.
   */
  private initialized = false;

  constructor(rulesFile: string, mockDataDir: string) {
    this.rulesFile = rulesFile;
    this.mockDataDir = mockDataDir;
  }

  add(rule: MockRule): MockRule {
    // Dedup: same url_pattern + type → replace (patch also checks path)
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.urlPattern === rule.urlPattern && r.type === rule.type) {
        if (r.type === 'patch' && r.path !== rule.path) continue;
        this.rules[i] = rule;
        return rule;
      }
    }
    this.rules.push(rule);
    return rule;
  }

  list(typeFilter?: RuleType): MockRuleData[] {
    const filtered = typeFilter
      ? this.rules.filter(r => r.type === typeFilter)
      : this.rules;
    return filtered.map(r => r.toDict());
  }

  delete(ruleId: string): boolean {
    // By id first
    const idx = this.rules.findIndex(r => r.id === ruleId);
    if (idx >= 0) {
      const rule = this.rules[idx];
      this.rules.splice(idx, 1);
      // Clean up mock data file if map_local(data)
      if (rule.dataFile) {
        const fp = path.join(this.mockDataDir, rule.dataFile);
        try { fs.unlinkSync(fp); } catch {}
      }
      return true;
    }
    // By numeric index (backward compat)
    const i = parseInt(ruleId, 10);
    if (!isNaN(i) && i >= 0 && i < this.rules.length) {
      this.rules.splice(i, 1);
      return true;
    }
    return false;
  }

  matched(url: string, protocol?: Protocol, typeFilter?: RuleType): MockRule[] {
    return this.rules.filter(r => {
      if (typeFilter && r.type !== typeFilter) return false;
      return r.matches(url, protocol);
    });
  }

  /**
   * Apply patch + map_local(data) rules to a decoded message object.
   * Returns the (possibly modified) data.
   */
  apply(url: string, protocol: Protocol, data: any): any {
    const matched = this.matched(url, protocol);
    let result = data;

    for (const rule of matched) {
      if (rule.type === 'map_local' && rule.source === 'data') {
        // Load mock data from external file
        if (rule.dataFile) {
          const fp = path.join(this.mockDataDir, rule.dataFile);
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            result = JSON.parse(content);
          } catch (e) {
            console.error(`[pbmockx] map_local data load failed: ${e}`);
          }
        } else if (rule.data !== undefined) {
          result = rule.data;
        }
      } else if (rule.type === 'patch') {
        // Patch: path navigation to set/append/insert/remove field
        if (rule.path) {
          const parts: PathSegment[] = parsePath(rule.path);
          switch (rule.action || 'set') {
            case 'append':
              appendByPath(result, parts, rule.value);
              break;
            case 'insert':
              insertByPath(result, parts, rule.index ?? 0, rule.value);
              break;
            case 'remove':
              removeByPath(result, parts, rule.index ?? 0);
              break;
            case 'unset':
              unsetByPath(result, parts);
              break;
            case 'set':
            default:
              setByPath(result, parts, rule.value);
              break;
          }
        }
      }
    }

    return result;
  }

  /**
   * Whether any patch / map_local(data) rule matches this URL — i.e. rules
   * that modify the response body inside resRead. map_remote / map_local(file)
   * are handled by rulesServer (whistle native rules), not in the pipe, so
   * they do not require a decode→encode round-trip. Request bodies are never
   * mocked.
   */
  hasDataRules(url: string, protocol?: Protocol): boolean {
    return this.matched(url, protocol).some(r =>
      r.type === 'patch' || (r.type === 'map_local' && r.source === 'data')
    );
  }

  save(): boolean {
    // save() serializes the WHOLE in-memory list, so writing before ever
    // reading disk silently deletes every existing rule. Guarantee we have
    // read disk first, and refuse to write if we could not — regardless of
    // how hooks are wired.
    if (!this.initialized) {
      // Rules added before this first save live only in memory; reload()
      // replaces this.rules with the on-disk set, so carry them across and
      // re-apply (add() dedups) to avoid dropping the pending mutation.
      const pending = this.rules.slice();
      this.reload();
      if (!this.initialized) {
        console.error('[pbmockx] refusing to save rules.yaml: could not read current rules');
        return false;
      }
      for (const r of pending) {
        this.add(r);
      }
    }
    try {
      // Preserve header comments
      let header = '';
      if (fs.existsSync(this.rulesFile)) {
        const old = fs.readFileSync(this.rulesFile, 'utf-8');
        for (const line of old.split('\n')) {
          if (line.trim().startsWith('#') || line.trim() === '') {
            header += line + '\n';
          } else {
            break;
          }
        }
      }
      const data = this.rules.map(r => r.toDict());
      const tmp = this.rulesFile + '.tmp';
      let out = '';
      if (header) out += header;
      out += yaml.dump(data, { indent: 2 });
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, this.rulesFile);
      return true;
    } catch (e) {
      console.error(`[pbmockx] save rules.yaml failed: ${e}`);
      return false;
    }
  }

  reload(): number {
    if (!fs.existsSync(this.rulesFile)) {
      // No rules file yet — a legitimate "no rules" disk state.
      this.initialized = true;
      return 0;
    }
    try {
      const content = fs.readFileSync(this.rulesFile, 'utf-8');
      const items = yaml.load(content) as MockRuleData[] || [];
      this.rules = items.map(item => new MockRule(item));
      this.initialized = true;
      return this.rules.length;
    } catch (e) {
      // Failed to read/parse — do NOT claim to know disk state, so save()
      // can never clobber a file we could not read.
      console.error(`[pbmockx] reload rules.yaml failed: ${e}`);
      return 0;
    }
  }

  /**
   * Generate whistle native rule lines for map_remote + map_local(file).
   * Used by rulesServer hook.
   */
  toWhistleRules(): string[] {
    const lines: string[] = [];
    for (const rule of this.rules) {
      if (rule.type === 'map_remote' && rule.replacement) {
        if (rule.isRegex) {
          lines.push(`/^${rule.urlPattern}$/ https://${rule.replacement}`);
        } else {
          lines.push(`${rule.urlPattern} https://${rule.replacement}`);
        }
      } else if (rule.type === 'map_local' && rule.source === 'file' && rule.filePath) {
        lines.push(`${rule.urlPattern} rawfile://${rule.filePath}`);
        if (rule.status) {
          lines.push(`${rule.urlPattern} statusCode://${rule.status}`);
        }
      }
    }
    return lines;
  }
}
