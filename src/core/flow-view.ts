/**
 * Shape adapters shared by the control API and the SSE event stream.
 * The summary keeps the field names the CLI has always consumed
 * (reqProto/resProto/hasReq/hasRes) and adds UI-only metadata.
 */

import type { FlowRecord } from './flow-store';

export function flowSummary(r: FlowRecord): any {
  return {
    id: r.id,
    url: r.url,
    originalUrl: r.originalUrl && r.originalUrl !== r.url ? r.originalUrl : undefined,
    method: r.method,
    status: r.status,
    reqProto: r.reqInfo?.protocol,
    resProto: r.resInfo?.protocol,
    reqMessageType: r.reqInfo?.messageType,
    resMessageType: r.resInfo?.messageType,
    hasReq: !!r.hasReq,
    hasRes: !!r.hasRes,
    error: r.error,
    patchError: r.patchError,
    durationMs: r.durationMs,
    resSize: r.resSize,
    reqSize: r.reqSize,
    mocked: !!r.mocked,
    upgrade: r.upgrade,
    ts: r.ts,
  };
}
