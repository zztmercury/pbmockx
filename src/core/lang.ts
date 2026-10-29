/**
 * Language resolution shared by the CLI, the daemon and (indirectly) the Web UI.
 *
 * Precedence:
 *   --lang <zh|en>            (CLI flag, propagated as PBMOCKX_LANG)
 *   PBMOCKX_LANG              (env)
 *   config.json {"lang": ...} (daemon / CLI default)
 *   LC_ALL / LC_MESSAGES / LANG / LANGUAGE  (system locale)
 *   en
 *
 * Only Chinese and English are supported today; anything else (fr_FR, C, ...)
 * falls back to English so behaviour is unchanged for non-Chinese systems.
 */

import type { PbmockxConfig } from './config';

export type Lang = 'en' | 'zh';

export const LANGS: readonly Lang[] = ['en', 'zh'];

/** Map "zh_CN.UTF-8", "zh-Hans", "en_US" … to a supported Lang, or null. */
export function normalizeLang(value: string | null | undefined): Lang | null {
  if (!value) return null;
  const v = String(value).trim().toLowerCase().replace(/_/g, '-').split('.')[0];
  if (!v) return null;
  if (v === 'zh' || v.startsWith('zh-')) return 'zh';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return null;
}

const SYSTEM_ENV_KEYS = ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'];

/** First recognisable language in the system locale env vars. */
export function detectLangFromEnv(env: NodeJS.ProcessEnv = process.env): Lang | null {
  for (const key of SYSTEM_ENV_KEYS) {
    const hit = normalizeLang(env[key]);
    if (hit) return hit;
  }
  return null;
}

export interface ResolveLangOptions {
  /** Value of --lang, if the user passed one. */
  explicit?: string | null;
  /** config.json "lang". */
  configLang?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function resolveLang(opts: ResolveLangOptions = {}): Lang {
  const env = opts.env || process.env;
  return (
    normalizeLang(opts.explicit) ||
    normalizeLang(env.PBMOCKX_LANG) ||
    normalizeLang(opts.configLang) ||
    detectLangFromEnv(env) ||
    'en'
  );
}

/** Convenience for callers that already have a loaded config object. */
export function resolveLangFromConfig(
  config: Partial<PbmockxConfig> | null | undefined,
  opts: Omit<ResolveLangOptions, 'configLang'> = {}
): Lang {
  const raw = config && typeof (config as any).lang === 'string' ? (config as any).lang : null;
  return resolveLang({ ...opts, configLang: raw });
}
