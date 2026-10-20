/**
 * Tiny HTTP client for the pbmockx daemon control API.
 */

import * as http from 'http';
import { resolvePort } from '../core/config';

export class ApiClient {
  constructor(public port: number, public host = '127.0.0.1') {}

  request(method: string, apiPath: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers: Record<string, any> = {};
      if (data !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(data);
      }
      const req = http.request(
        { hostname: this.host, port: this.port, path: '/__pbmockx/api' + apiPath, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if ((res.statusCode || 500) >= 400) {
              let msg = raw;
              try { msg = JSON.parse(raw).error || raw; } catch {}
              reject(new Error(msg || `HTTP ${res.statusCode}`));
              return;
            }
            try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
          });
        }
      );
      req.on('error', (e: any) => {
        if (e && e.code === 'ECONNREFUSED') {
          reject(new Error(
            `pbmockx daemon is not running on 127.0.0.1:${this.port}. Run: pbmockx start`
          ));
        } else {
          reject(e);
        }
      });
      req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
      if (data !== null) req.write(data);
      req.end();
    });
  }

  get(p: string): Promise<any> { return this.request('GET', p); }
  post(p: string, body?: any): Promise<any> { return this.request('POST', p, body); }
  del(p: string): Promise<any> { return this.request('DELETE', p); }
}

export function client(port: number = resolvePort()): ApiClient {
  return new ApiClient(port);
}

export async function health(port: number, host = '127.0.0.1'): Promise<any> {
  const h = await new ApiClient(port, host).get('/health');
  if (!h || h.ok !== true) throw new Error('not a pbmockx daemon');
  return h;
}
