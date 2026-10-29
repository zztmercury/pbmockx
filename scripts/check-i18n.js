#!/usr/bin/env node
'use strict';

/**
 * Verify the Web UI message catalogs are complete and consistent.
 *
 *   node scripts/check-i18n.js
 *
 * Checks:
 *   1. dict.en and dict.zh in web/i18n.js declare exactly the same keys
 *   2. every t('key') in web/*.js exists in both catalogs
 *   3. every data-i18n / data-i18n-title / data-i18n-aria / data-i18n-placeholder
 *      value in web/index.html exists in both catalogs
 *
 * The CLI catalogs do not need this: src/i18n/zh.ts is typed as
 * Record<MsgKey, string>, so a missing translation fails `tsc`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/** Remove comments, keeping strings intact (needed to find t('key') calls). */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        i++;
      }
      out += i < src.length ? quote : '';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Keys declared by the object literal following `name: {`.
 * Walks the real source (comments skipped) and treats a quoted string at
 * depth 1 followed by `:` as a key.
 */
function catalogKeys(src, name) {
  const at = src.indexOf(name + ': {');
  if (at < 0) throw new Error(`web/i18n.js: no "${name}: {" catalog found`);
  let i = src.indexOf('{', at);
  let depth = 0;
  const keys = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; if (depth === 0) break; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') { value += src[j + 1] || ''; j += 2; continue; }
        value += src[j];
        j++;
      }
      if (depth === 1) {
        let k = j + 1;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === ':') keys.push(value);
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return keys;
}

function usedKeys() {
  const used = new Map(); // key -> [files]
  const add = (key, where) => {
    if (!used.has(key)) used.set(key, new Set());
    used.get(key).add(where);
  };
  for (const file of fs.readdirSync(WEB).filter((f) => f.endsWith('.js') && f !== 'i18n.js')) {
    const src = stripComments(fs.readFileSync(path.join(WEB, file), 'utf-8'));
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) add(m[1], file);
  }
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf-8');
  for (const m of html.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="([^"]+)"/g)) add(m[1], 'index.html');
  return used;
}

function main() {
  const src = fs.readFileSync(path.join(WEB, 'i18n.js'), 'utf-8');
  const en = catalogKeys(src, 'en');
  const zh = catalogKeys(src, 'zh');
  const enSet = new Set(en);
  const zhSet = new Set(zh);
  const problems = [];

  for (const key of en) if (!zhSet.has(key)) problems.push(`missing in zh: ${key}`);
  for (const key of zh) if (!enSet.has(key)) problems.push(`missing in en: ${key}`);

  const used = usedKeys();
  for (const [key, where] of used) {
    if (!enSet.has(key) || !zhSet.has(key)) {
      problems.push(`used but not declared (${[...where].join(', ')}): ${key}`);
    }
  }

  if (en.length !== enSet.size) problems.push('duplicate key in en');
  if (zh.length !== zhSet.size) problems.push('duplicate key in zh');

  if (problems.length) {
    console.error(`i18n: ${problems.length} problem(s)`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`i18n: OK — ${enSet.size} keys (en/zh), ${used.size} referenced`);
}

main();
