/**
 * SSE hub for the Web UI: flow.new / flow.update / rules.changed / status.
 */

import * as http from 'http';

export class EventHub {
  private clients = new Set<any>();
  private timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.ping(), 15000);
    this.timer.unref();
  }

  subscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    const cleanup = () => {
      this.clients.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  broadcast(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }

  private ping(): void {
    for (const res of this.clients) {
      try { res.write(': ping\n\n'); } catch { this.clients.delete(res); }
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const res of this.clients) {
      try { res.end(); } catch {}
    }
    this.clients.clear();
  }
}
