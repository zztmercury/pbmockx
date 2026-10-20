/**
 * PBEngine — protobuf dynamic decode/encode using protobufjs.
 *
 * Replicates Python pbmockx_addon.py PBEngine (lines 151-244) but operates
 * directly on message objects (NOT JSON) to avoid int64→string / enum→string
 * ambiguity that would mislead AI agents.
 *
 * Key differences from the Python version:
 * - Root.fromDescriptor() + resolveAll() replaces manual topological pool.Add
 * - encodeDelimited/decodeDelimited replaces hand-rolled varint
 * - `long` library for int64 precision
 * - No proto3 JSON serialization — message objects are used directly
 */

import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor';
import Long from 'long';
import type { DescResult } from './desc-cache';

// protobufjs needs Long for int64 support
protobuf.util.Long = Long as any;
protobuf.configure();

// Monkey-patch Root.fromDescriptor to NOT call resolveAll() internally.
// The original calls root.resolveAll() before returning, which throws if
// the .desc has custom extensions on google.protobuf.*Options types.
// We need to inject WKT definitions first, then resolveAll ourselves.
const _originalFromDescriptor = (protobuf.Root as any).fromDescriptor;
(protobuf.Root as any).fromDescriptor = function(descriptor: any) {
  const _resolveAll = protobuf.Root.prototype.resolveAll;
  protobuf.Root.prototype.resolveAll = function() { return this; };
  try {
    return _originalFromDescriptor.call(this, descriptor);
  } finally {
    protobuf.Root.prototype.resolveAll = _resolveAll;
  }
};

// Well-known types not included in TapTap .desc but referenced as deps.
// protobufjs common has 7 built-in; we also load descriptor.proto (for
// custom extensions on Options types), api.proto, source_context.proto,
// type.proto — matching the Python _WELL_KNOWN list.
const WKT_FILES = [
  'google/protobuf/any.proto',
  'google/protobuf/timestamp.proto',
  'google/protobuf/duration.proto',
  'google/protobuf/struct.proto',
  'google/protobuf/wrappers.proto',
  'google/protobuf/field_mask.proto',
  'google/protobuf/empty.proto',
];

// Extra WKTs not in protobufjs common — loaded from package's JSON files
// descriptor.proto is critical: it defines MethodOptions, FieldOptions, etc.
// that custom extensions in TapTap .desc extend.
const EXTRA_WKT_JSON = [
  'google/protobuf/descriptor.json',
  'google/protobuf/api.json',
  'google/protobuf/source_context.json',
  'google/protobuf/type.json',
];

// Cache the JSON path so we only resolve it once
let protojsDir: string | null = null;
function getProtojsDir(): string | null {
  if (protojsDir) return protojsDir;
  try {
    const path = require('path');
    protojsDir = path.dirname(require.resolve('protobufjs'));
    return protojsDir;
  } catch {
    protojsDir = __dirname.replace(/\/dist\/.*$/, '/node_modules/protobufjs');
    return protojsDir;
  }
}

export class PBEngine {
  private rootCache = new Map<string, protobuf.Root>();
  private descCache: { get: (url: string) => Promise<DescResult> };

  constructor(descCache?: { get: (url: string) => Promise<DescResult> }) {
    this.descCache = descCache || new DescCacheShim();
  }

  private async getRoot(descUrl: string): Promise<protobuf.Root> {
    // Every call issues a conditional request (If-Modified-Since/If-None-Match).
    // 304 → reuse the compiled Root; 200 + changed bytes → rebuild.
    const { bytes: descBytes, changed } = await this.descCache.get(descUrl);
    const cached = this.rootCache.get(descUrl);
    if (cached && !changed) return cached;

    const root = (protobuf.Root as any).fromDescriptor(descBytes, { keepCase: true });

    // Inject well-known type definitions that .desc may reference but not include
    for (const file of WKT_FILES) {
      try {
        const common = protobuf.common.get(file);
        if (common && (common as any).nested) {
          root.addJSON((common as any).nested);
        }
      } catch {
        // already present or not needed — skip
      }
    }

    // Inject extra WKTs (descriptor.proto, api.proto, etc.) directly into root
    // These define google.protobuf.MethodOptions, FieldOptions, etc. that
    // custom extensions in the .desc extend.
    const dir = getProtojsDir();
    if (dir) {
      const fs = require('fs');
      const path = require('path');
      for (const file of EXTRA_WKT_JSON) {
        try {
          const fp = path.join(dir, file);
          if (fs.existsSync(fp)) {
            const json = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            if (json.nested) {
              root.addJSON(json.nested);
            }
          }
        } catch {
          // skip if file missing or parse error
        }
      }
    }

    // resolveAll may fail on unresolvable extensions (custom options on
    // google.protobuf.*Options). These are non-critical metadata, not
    // needed for message decode/encode. Catch and continue.
    try {
      root.resolveAll();
    } catch (e: any) {
      console.warn('[pbmockx] resolveAll partial failure (non-critical for decode):', String(e.message || e).slice(0, 120));
    }

    this.rootCache.set(descUrl, root);
    return root;
  }

  async getMessageType(descUrl: string, messageType: string): Promise<protobuf.Type> {
    const root = await this.getRoot(descUrl);
    return root.lookupType(messageType);
  }

  /**
   * Decode PB bytes into a protobufjs message object.
   * For delimited=true, returns an array of message objects.
   */
  async decode(
    descUrl: string,
    messageType: string,
    delimited: boolean,
    data: Buffer
  ): Promise<any> {
    const MsgType = await this.getMessageType(descUrl, messageType);
    if (delimited) {
      const reader = protobuf.Reader.create(data as any);
      const list: any[] = [];
      while (reader.pos < reader.len) {
        list.push(MsgType.decodeDelimited(reader));
      }
      return list;
    }
    return MsgType.decode(data as any);
  }

  /**
   * Encode a message object (or array for delimited) back to PB bytes.
   * The input should be a protobufjs message object or a plain object
   * compatible with MsgType.fromObject().
   */
  async encode(
    descUrl: string,
    messageType: string,
    delimited: boolean,
    data: any
  ): Promise<Buffer> {
    const MsgType = await this.getMessageType(descUrl, messageType);
    if (delimited) {
      const writer = protobuf.Writer.create();
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const msg = item instanceof protobuf.Message ? item : MsgType.fromObject(item);
        MsgType.encodeDelimited(msg, writer);
      }
      return Buffer.from(writer.finish());
    }
    const msg = data instanceof protobuf.Message ? data : MsgType.fromObject(data);
    return Buffer.from(MsgType.encode(msg).finish());
  }
}

// Default shim if no DescCache provided
class DescCacheShim {
  async get(url: string): Promise<DescResult> {
    throw new Error('DescCacheShim does not support raw .desc URLs; provide a DescCache instance');
  }
}

// Re-export DescCache for convenience
export { DescCache } from './desc-cache';
