/**
 * Minimal leveled logger. Writes to stderr and (when configured) a log file.
 * The daemon redirects stdout/stderr to the log file when spawned detached;
 * setLogFile is used for foreground runs so `pbmockx logs` still works.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = (process.env.PBMOCKX_LOG_LEVEL as LogLevel) || 'info';
let logFile: string | null = null;

export function setLogFile(file: string): void {
  logFile = file;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function write(level: LogLevel, args: any[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a)))
    .join(' ');
  const line = `[${ts}] [${level}] ${msg}`;
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  }
  if (!logFile || process.env.PBMOCKX_LOG_STDERR === '1') {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  }
}

function safeJson(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = {
  debug: (...a: any[]) => write('debug', a),
  info: (...a: any[]) => write('info', a),
  warn: (...a: any[]) => write('warn', a),
  error: (...a: any[]) => write('error', a),
};

export function tailFile(file: string, lines = 80): string {
  try {
    const buf = fs.readFileSync(file, 'utf-8');
    const arr = buf.split('\n');
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr.slice(-lines).join('\n');
  } catch (e: any) {
    return `(cannot read ${file}: ${e.message})`;
  }
}
