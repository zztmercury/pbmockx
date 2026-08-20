/**
 * Shared helpers for pipe hooks.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Read all data from a readable stream into a Buffer. */
export function readBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const onData = (c: Buffer) => chunks.push(c);
    const onEnd = () => settle();
    const onError = (e: any) => settle(e);
    // whistle pipe decoder emits 'close' (NOT 'end'/'error') when the socket
    // is reset or the client disconnects mid-body. If the stream already ended
    // (readableEnded), close is a normal post-end cleanup → resolve. Otherwise
    // close means we got torn down before the \n0\n terminal frame → reject so
    // the hook can record the abort instead of treating partial bytes as a
    // complete body.
    const onClose = () => {
      if (req.readableEnded) settle();
      else settle(new Error('pipe closed before terminal frame'));
    };

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
    };

    const settle = (err?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);

    // Defensive: stream may already be fully consumed/ended before we attached.
    if (req.readableEnded) settle();
  });
}

/**
 * 关键路径日志：记录 pipe hook 请求/响应的到达、读取、转发时刻与耗时。
 * 用于定位超时——通过 req 的 forwarded 与 res 的 begin 时间戳差，可算出
 * 服务器处理耗时；若 res 无日志，说明响应未到达 resRead（客户端已断开）。
 * 格式：[pbmockx:<dir>] HH:MM:SS.mmm <sessionId> <msg>
 *
 * 注意：whistle daemon 把插件进程的 stdout 重定向到 /dev/null，console.log
 * 会被丢弃；stderr 也不可靠。所以这里直接用 appendFileSync 写独立日志文件
 * （同步写保证并发下日志顺序正确，便于算时序；仅诊断期启用，用后应移除）。
 */
const PIPE_LOG_FILE = path.join(os.homedir(), '.pbmockx', 'pipe.log');
// 诊断日志开关：默认开（写 ~/.pbmockx/pipe.log）。定位偶发超时时直接看日志；
// 确认无问题后可置 false 关闭（appendFileSync 同步 IO 会拖慢高 QPS）。
const PIPE_LOG_ENABLED = true;
export function pipeLog(dir: 'req' | 'res', sessionId: string, msg: string): void {
  if (!PIPE_LOG_ENABLED) return;
  const ts = new Date().toISOString().slice(11, 23);
  try {
    fs.appendFileSync(PIPE_LOG_FILE, `[pbmockx:${dir}] ${ts} ${sessionId} ${msg}\n`);
  } catch {}
}

/** Generate a short flow ID. */
export function genFlowId(url: string, ts: number): string {
  const hash = crypto.createHash('md5').update(`${url}${ts}`).digest('hex');
  return hash.substring(0, 8);
}

/** Deep clone a PB message object or JSON object. */
export async function cloneData(
  data: any,
  protocol: 'protobuf' | 'json',
  pbEngine?: any,
  desc?: string,
  messageType?: string,
  delimited?: boolean
): Promise<any> {
  if (protocol === 'json') {
    return JSON.parse(JSON.stringify(data));
  }
  // PB: re-encode and re-decode for a proper deep copy
  if (pbEngine && desc && messageType) {
    const encoded = await pbEngine.encode(desc, messageType, delimited || false, data);
    return await pbEngine.decode(desc, messageType, delimited || false, encoded);
  }
  return data;
}
