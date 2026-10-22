/**
 * CLI rendering helpers (tables, headers, decoded bodies).
 */

import { renderTree, renderTreeCollapsed, navigatePath } from '../core/field-tree';
import { TUNNEL_REASON_TEXT, type TunnelReason } from '../core/flow-store';

export function fmtBytes(n: number | undefined | null): string {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * A CONNECT tunnel pbmockx never decrypted. Printing something explicit here
 * matters: "no flow at all" and "flow with a reason" are the difference
 * between a broken proxy setup and an intentional bypass.
 */
export function printTunnel(d: any): void {
  const reason = TUNNEL_REASON_TEXT[d.tunnel as TunnelReason] || String(d.tunnel);
  console.log('=== Tunnel (not decrypted) ===');
  console.log('CONNECT ' + (d.url || ''));
  console.log('reason: ' + reason);
  if (d.error) console.log('error: ' + d.error);
  console.log('bytes: up ' + fmtBytes(d.tunnelBytesUp) + '  down ' + fmtBytes(d.tunnelBytesDown));
  if (d.tunnelClose) console.log('closed: ' + d.tunnelClose);
  if (d.clientIp) console.log('client: ' + d.clientIp);
  console.log('flow id: ' + d.id);
}

export function printTable(rows: any[], headers?: string[]): void {
  if (!rows || rows.length === 0) {
    console.log('(none)');
    return;
  }
  const keys = headers || Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] != null ? r[k] : '').length))
  );
  console.log(keys.map((k, i) => k.padEnd(widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(keys.map((k, i) => String(r[k] != null ? r[k] : '').padEnd(widths[i])).join('  '));
  }
}

export function formatHeaders(headers: Record<string, any> | undefined, prefix: string): string {
  if (!headers) return prefix + '(no headers)';
  return Object.entries(headers)
    .map(([k, v]) => prefix + k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
    .join('\n');
}

export interface PrintSectionOptions {
  title: string;
  methodLine: string;
  url: string;
  headers?: Record<string, any>;
  protocol?: string;
  messageType?: string;
  body: any;
  original: boolean;
  path?: string;
  fullExpand: boolean;
  showHeaders: boolean;
  decodeError?: string;
}

export function printSection(o: PrintSectionOptions): void {
  const suppressHeader = (o.path || o.fullExpand) && !o.showHeaders;
  if (!suppressHeader) {
    console.log('=== ' + o.title + ' ===');
    console.log(o.methodLine + ' ' + (o.url || ''));
    if (o.headers) {
      for (const [k, v] of Object.entries(o.headers)) {
        console.log(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
      }
    }
    console.log('');
  }
  if (o.decodeError) {
    console.log('(decode error: ' + o.decodeError + ')');
  }
  if (o.body !== undefined && o.body !== null) {
    let label: string;
    if (o.protocol === 'json') label = o.title + ' Body (JSON)';
    else if (o.protocol === 'form') label = o.title + ' Body (Form)';
    else label = o.title + ' Body (PB: ' + (o.messageType || '?') + ')';
    console.log('=== ' + label + (o.original ? ' [original]' : '') + ' ===');
    if (o.protocol === 'json') {
      console.log(JSON.stringify(o.body, null, 2));
    } else if (o.protocol === 'form') {
      const entries = Object.entries(o.body);
      if (!entries.length) {
        console.log('(empty)');
      } else {
        const maxKey = Math.max(...entries.map((e) => e[0].length));
        for (const [k, v] of entries) {
          console.log(k + ' '.repeat(Math.max(2, maxKey - k.length + 2)) + '= ' + (Array.isArray(v) ? v.join(', ') : String(v)));
        }
      }
    } else if (o.body && o.body.fields) {
      try {
        if (o.fullExpand) {
          console.log(renderTree(o.body));
        } else if (o.path) {
          const subtree = navigatePath(o.body, o.path);
          if (subtree) {
            console.log(renderTreeCollapsed(subtree));
          } else {
            console.log('Path not found: ' + o.path);
            console.log('Available top-level fields: ' + o.body.fields.map((f: any) => f.name).join(', '));
          }
        } else {
          console.log(renderTreeCollapsed(o.body));
        }
      } catch {
        console.log(JSON.stringify(o.body, null, 2));
      }
    } else if (Array.isArray(o.body)) {
      // delimited protobuf with an empty first message still has .fields
      console.log(JSON.stringify(o.body, null, 2));
    }
  }
}
