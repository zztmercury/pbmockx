/**
 * Content-Type parsing — replicates Charles self-describing protobuf rules.
 *
 * application/x-protobuf; desc="http://host/Model.desc"; messageType="demo.Person"; delimited=true
 */

const PB_CT_RE = /application\/x-(google-)?protobuf/i;
const FORM_CT_RE = /application\/x-www-form-urlencoded/i;

const DESC_RE = /desc\s*=\s*"([^"]+)"/i;
const DESC_RE_BARE = /desc\s*=\s*([^\s;]+)/i;
const MSGTYPE_RE = /messageType\s*=\s*"([^"]+)"/i;
const MSGTYPE_RE_BARE = /messageType\s*=\s*([^\s;]+)/i;
const DELIM_RE = /delimited\s*=\s*true/i;

export interface CtParams {
  desc?: string;
  messageType?: string;
  delimited: boolean;
}

export function parseCtParams(ct: string): CtParams {
  if (!ct) return { delimited: false };
  let desc: string | undefined;
  let m = DESC_RE.exec(ct) || DESC_RE_BARE.exec(ct);
  if (m) desc = m[1];
  let messageType: string | undefined;
  m = MSGTYPE_RE.exec(ct) || MSGTYPE_RE_BARE.exec(ct);
  if (m) messageType = m[1];
  return { desc, messageType, delimited: DELIM_RE.test(ct) };
}

export function isPb(ct: string): boolean {
  return !!ct && PB_CT_RE.test(ct);
}

export function isJson(ct: string, data: Buffer): boolean {
  if (ct && /json/i.test(ct)) return true;
  if (!data || data.length === 0) return false;
  try {
    JSON.parse(data.toString('utf-8'));
    return true;
  } catch {
    return false;
  }
}

export function isForm(ct: string): boolean {
  return !!ct && FORM_CT_RE.test(ct);
}

/** Parse urlencoded body into an object. Repeated keys collapse to an array. */
export function parseForm(data: Buffer): Record<string, any> {
  const params = new URLSearchParams(data.toString('utf-8'));
  const obj: Record<string, any> = {};
  const seen = new Set<string>();
  for (const [k] of params) {
    if (seen.has(k)) continue;
    seen.add(k);
    const vals = params.getAll(k);
    obj[k] = vals.length > 1 ? vals : vals[0];
  }
  return obj;
}

export type Protocol = 'protobuf' | 'json' | 'form';

export interface DetectInfo {
  protocol: Protocol;
  desc?: string;
  messageType?: string;
  delimited: boolean;
}

/** Detect protocol from content-type + body. Returns null if not PB/JSON/Form. */
export function detect(
  ct: string,
  data: Buffer
): DetectInfo | null {
  if (isPb(ct)) {
    return { protocol: 'protobuf', ...parseCtParams(ct) };
  }
  if (isForm(ct)) {
    return { protocol: 'form', delimited: false };
  }
  if (isJson(ct, data)) {
    return { protocol: 'json', delimited: false };
  }
  return null;
}
