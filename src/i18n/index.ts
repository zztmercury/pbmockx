/**
 * Tiny CLI i18n runtime: no dependencies, no JSON loading, no runtime key
 * validation (the catalogs are type-checked at build time).
 *
 * Usage:
 *   import { t, setLang, getLang, initLang } from '../i18n';
 *   setLang(resolveLang({ explicit: argvLang }));
 *   console.log(t('rules.added', { id, url, path }));
 */

import { normalizeLang, resolveLangFromConfig, type Lang } from '../core/lang';
import type { PbmockxConfig } from '../core/config';
import { en, type MsgKey } from './en';
import { zh } from './zh';

export type { MsgKey, Lang };

export const dicts: Record<Lang, Record<MsgKey, string>> = { en, zh };

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = dicts[lang] ? lang : 'en';
}

export function getLang(): Lang {
  return current;
}

/** Resolve the language from --lang / env / config and apply it. */
export function initLang(opts: { explicit?: string | null; config?: Partial<PbmockxConfig> | null } = {}): Lang {
  const lang: Lang = opts.explicit
    ? normalizeLang(opts.explicit) || 'en'
    : resolveLangFromConfig(opts.config, { env: process.env });
  setLang(lang);
  return lang;
}

/** Translate a key, substituting `{name}` placeholders. */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  const table = dicts[current] || en;
  let s: string = table[key] ?? en[key] ?? key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  }
  return s;
}

/** Keys that exist in one catalog but not the other (used by tests). */
export function catalogKeyDiff(): { missingInZh: MsgKey[]; missingInEn: MsgKey[] } {
  const enKeys = Object.keys(en) as MsgKey[];
  const zhKeys = Object.keys(zh) as MsgKey[];
  return {
    missingInZh: enKeys.filter((k) => !(k in zh)),
    missingInEn: zhKeys.filter((k) => !(k in en)),
  };
}
