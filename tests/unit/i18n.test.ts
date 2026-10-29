/**
 * i18n plumbing: language resolution, catalog parity and the `--lang` flag.
 *
 * The catalogs themselves are checked at compile time (zh is typed as
 * Record<MsgKey, string>); these tests cover runtime behaviour plus the one
 * thing types cannot see: that the CLI actually switches language.
 */

import { test } from 'node:test';
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectLangFromEnv, normalizeLang, resolveLang, resolveLangFromConfig } from '../../src/core/lang';
import { catalogKeyDiff, dicts, getLang, setLang, t } from '../../src/i18n';
import { packageRoot } from '../../src/core/config';

const CLI = path.join(packageRoot(), 'bin', 'pbmockx.js');

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PBMOCKX_LANG: '', LANG: 'en_US.UTF-8', LC_ALL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s);

/** Run the CLI and return {status, stdout, stderr} without throwing on failure. */
function runCliResult(args: string[], env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, PBMOCKX_LANG: '', LANG: 'en_US.UTF-8', LC_ALL: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('normalizeLang accepts locale strings and rejects unsupported ones', () => {
  assert.equal(normalizeLang('zh'), 'zh');
  assert.equal(normalizeLang('zh_CN.UTF-8'), 'zh');
  assert.equal(normalizeLang('zh-Hans-CN'), 'zh');
  assert.equal(normalizeLang('ZH'), 'zh');
  assert.equal(normalizeLang('en_US.UTF-8'), 'en');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('fr_FR.UTF-8'), null);
  assert.equal(normalizeLang('C'), null);
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(undefined), null);
});

test('resolveLang follows the documented precedence', () => {
  // explicit flag beats everything
  assert.equal(resolveLang({ explicit: 'en', configLang: 'zh', env: { LANG: 'zh_CN.UTF-8' } }), 'en');
  assert.equal(resolveLang({ explicit: 'zh', env: { LANG: 'en_US.UTF-8' } }), 'zh');
  // env beats config
  assert.equal(resolveLang({ configLang: 'zh', env: { PBMOCKX_LANG: 'en', LANG: 'zh_CN.UTF-8' } }), 'en');
  // config beats system locale
  assert.equal(resolveLang({ configLang: 'zh', env: { LANG: 'en_US.UTF-8' } }), 'zh');
  // system locale when nothing else is set
  assert.equal(resolveLang({ env: { LC_ALL: 'zh_CN.UTF-8' } }), 'zh');
  assert.equal(detectLangFromEnv({ LANGUAGE: 'zh_TW:zh' }), 'zh');
  // unsupported locale falls back to English
  assert.equal(resolveLang({ env: { LANG: 'fr_FR.UTF-8' } }), 'en');
  assert.equal(resolveLang({ env: {} }), 'en');
});

test('resolveLangFromConfig reads config.lang', () => {
  assert.equal(resolveLangFromConfig({ lang: 'zh' }, { env: {} }), 'zh');
  assert.equal(resolveLangFromConfig({}, { env: { LANG: 'zh_CN.UTF-8' } }), 'zh');
  assert.equal(resolveLangFromConfig({ lang: 'en' }, { env: { LANG: 'zh_CN.UTF-8' } }), 'en');
  assert.equal(resolveLangFromConfig(null, { env: {} }), 'en');
});

test('en and zh catalogs have exactly the same keys', () => {
  const diff = catalogKeyDiff();
  assert.deepEqual(diff.missingInZh, []);
  assert.deepEqual(diff.missingInEn, []);
  assert.ok(Object.keys(dicts.en).length > 0);
  for (const [key, value] of Object.entries(dicts.en)) {
    assert.equal(typeof value, 'string', `en[${key}] must be a string`);
    assert.ok(value.length > 0, `en[${key}] must not be empty`);
  }
  for (const [key, value] of Object.entries(dicts.zh)) {
    assert.ok(typeof value === 'string' && value.length > 0, `zh[${key}] must be a non-empty string`);
  }
});

test('t() substitutes placeholders and switches catalogs', () => {
  const previous = getLang();
  try {
    setLang('en');
    for (const key of Object.keys(dicts.en)) {
      assert.equal(t(key as any), dicts.en[key as never]);
    }
    setLang('zh');
    for (const key of Object.keys(dicts.zh)) {
      assert.equal(t(key as any), dicts.zh[key as never]);
    }
  } finally {
    setLang(previous);
  }
});

test('CLI honours --lang and PBMOCKX_LANG', () => {
  const en = runCli(['--lang', 'en', '-h']);
  const zh = runCli(['--lang', 'zh', '-h']);
  assert.ok(en.includes('Usage: pbmockx'), 'English help must keep the Usage line');
  assert.ok(!hasCjk(en), 'English help must not contain Chinese');
  assert.ok(hasCjk(zh), 'Chinese help must contain Chinese');
  assert.ok(zh.includes('Usage: pbmockx'), 'command/flags stay English in Chinese help');

  // env var, no flag
  const zhEnv = runCli(['-h'], { PBMOCKX_LANG: 'zh' });
  assert.ok(hasCjk(zhEnv));

  // system locale detection (no flag, no env)
  const zhSys = runCli(['-h'], { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });
  assert.ok(hasCjk(zhSys), 'system locale should select Chinese');
});

test('CLI version line is stable across languages', () => {
  const en = runCli(['--lang', 'en', 'version']).trim();
  const zh = runCli(['--lang', 'zh', 'version']).trim();
  assert.ok(/pbmockx \d+\.\d+\.\d+/.test(en), `unexpected version output: ${en}`);
  assert.equal(en, zh);
});

test('pbmockx lang shows, persists and clears the language', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbmockx-lang-'));
  try {
    // nothing configured, English system locale
    const initial = JSON.parse(runCli(['--data-dir', dir, 'lang', '--json']));
    assert.equal(initial.lang, 'en');
    assert.equal(initial.config, null);

    // persist zh
    const set = runCliResult(['--data-dir', dir, 'lang', 'zh']);
    assert.equal(set.status, 0, set.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')), { lang: 'zh' });

    // the switch applies to this very command's output and to later runs
    assert.ok(hasCjk(set.stdout), 'confirmation should be printed in the new language');
    const after = JSON.parse(runCli(['--data-dir', dir, 'lang', '--json']));
    assert.equal(after.lang, 'zh');
    assert.equal(after.source, 'config');
    assert.ok(hasCjk(runCli(['--data-dir', dir, 'doctor'])), 'CLI text follows config.json');

    // env still wins over config
    assert.equal(JSON.parse(runCli(['--data-dir', dir, 'lang', '--json'], { PBMOCKX_LANG: 'en' })).lang, 'en');

    // auto removes the key
    const cleared = runCliResult(['--data-dir', dir, 'lang', 'auto']);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')), {});
    assert.equal(JSON.parse(runCli(['--data-dir', dir, 'lang', '--json'])).lang, 'en');

    // unsupported value is rejected
    const bad = runCliResult(['--data-dir', dir, 'lang', 'fr']);
    assert.notEqual(bad.status, 0);
    assert.ok(bad.stderr.includes('fr'), 'error should name the value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
