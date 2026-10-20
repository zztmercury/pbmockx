/**
 * `pbmockx rules add` argv parsing + patch payload construction.
 *
 * Kept pure (except process.exit on invalid input) so the CLI tests can
 * exercise the exact same code path as the real command. The names with an
 * underscore prefix are the historical API and are kept for compatibility.
 */

export interface ParsedRulesAdd {
  url: string;
  rulePath: string;
  value?: string;
  action?: 'append' | 'insert' | 'remove' | 'unset';
  index?: number;
  protocol?: string;
}

export const RULES_ADD_USAGE =
  'Usage: pbmockx rules add <url> <path> <value> [--protocol pb|json]\n' +
  '       pbmockx rules add <url> <path> --append <value>\n' +
  '       pbmockx rules add <url> <path> --insert <idx> <value>\n' +
  '       pbmockx rules add <url> <path> --remove <idx>\n' +
  '       pbmockx rules add <url> <path> --unset';

function fail(msg: string): never {
  console.error('Error: ' + msg);
  console.error(RULES_ADD_USAGE);
  process.exit(1);
}

export function parseValue(s: any): any {
  if (s === undefined) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

/** Historical name kept for tests / external callers. */
export const _parseValue = parseValue;

/**
 * Parse `rules add` arguments (the leading "add" subcommand must already be
 * stripped). Known flags consume their params first; every remaining token is
 * a positional in order: url, rulePath, value. A token starting with "-" that
 * is NOT a known flag stays positional (so "-1" is a valid value); a token
 * starting with "--" that is unknown is an error.
 */
export function _parseRulesAddArgs(args: string[]): ParsedRulesAdd {
  const positionals: string[] = [];
  let protocol: string | undefined;
  let action: ParsedRulesAdd['action'];
  let index: number | undefined;
  let appendValue: string | undefined;
  let actionCount = 0;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--protocol') {
      if (args[i + 1] === undefined) fail('--protocol requires a <value>');
      protocol = args[++i];
    } else if (a === '--append') {
      if (args[i + 1] === undefined) fail('--append requires a <value>');
      appendValue = args[++i];
      action = 'append';
      actionCount++;
    } else if (a === '--insert') {
      const idxRaw = args[i + 1];
      if (!idxRaw || !/^\d+$/.test(idxRaw)) fail('--insert requires a non-negative <idx>');
      index = parseInt(idxRaw, 10);
      i++;
      action = 'insert';
      actionCount++;
    } else if (a === '--remove') {
      const idxRaw = args[i + 1];
      if (!idxRaw || !/^\d+$/.test(idxRaw)) fail('--remove requires a non-negative <idx>');
      index = parseInt(idxRaw, 10);
      i++;
      action = 'remove';
      actionCount++;
    } else if (a === '--unset') {
      action = 'unset';
      actionCount++;
    } else if (a.startsWith('--')) {
      fail('unknown flag: ' + a);
    } else {
      positionals.push(a);
    }
  }

  if (actionCount > 1) fail('--append/--insert/--remove/--unset are mutually exclusive');

  const url = positionals[0];
  const rulePath = positionals[1];
  const positionalValue = positionals[2];
  const noTarget = !url || !rulePath;

  if (action === 'append') {
    if (noTarget) fail('missing <url> and/or <path>');
    return { url, rulePath, value: appendValue, action, index: undefined, protocol };
  }
  if (action === 'insert' || action === 'remove') {
    if (noTarget) fail('missing <url> and/or <path>');
    if (action === 'insert' && positionalValue === undefined) fail('--insert requires a <value>');
    return { url, rulePath, value: action === 'insert' ? positionalValue : undefined, action, index, protocol };
  }
  if (action === 'unset') {
    if (noTarget) fail('missing <url> and/or <path>');
    return { url, rulePath, value: undefined, action, index: undefined, protocol };
  }
  if (noTarget) fail('missing <url> and/or <path>');
  if (positionalValue === undefined) fail('missing <value> for set (use --append/--unset if intended)');
  return { url, rulePath, value: positionalValue, action: undefined, index: undefined, protocol };
}

export function _buildPatchRule(parsed: ParsedRulesAdd): any {
  const rule: any = { type: 'patch', url_pattern: parsed.url, path: parsed.rulePath };
  const protocol = parsed.protocol === 'pb' ? 'protobuf' : parsed.protocol;
  if (protocol) rule.protocol = protocol;
  if (parsed.action) rule.action = parsed.action;
  if (parsed.index !== undefined) rule.index = parsed.index;
  if (parsed.value !== undefined) rule.value = parseValue(parsed.value);
  return rule;
}

/** Render a rule's value for the "Rule added:" echo line. */
export function _renderRuleValue(rule: any, fallbackAction?: string): string {
  if (!rule) return '';
  const action = rule.action !== undefined ? rule.action : fallbackAction;
  if (action === 'unset') return '(unset)';
  if (rule.value !== undefined) return JSON.stringify(rule.value);
  return '';
}
