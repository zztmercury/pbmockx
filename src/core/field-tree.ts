/**
 * Field tree builder — constructs a structured representation of a protobufjs
 * message object using its descriptor, for display in inspectorsTab and CLI.
 *
 * Unlike proto3 JSON serialization, this preserves native types:
 * - int64/uint64 → number (or Long.toString()) with "(int64)" annotation
 * - enum → number with name lookup "(enum Status, ACTIVE)"
 * - bytes → base64 string with "(bytes, N)"
 * - message → recursive field list
 * - Any → decode value based on type_url, show nested fields
 *
 * This avoids the int64→string / enum→string ambiguity that misleads AI.
 */

import protobuf from 'protobufjs';

export type FieldKind = 'scalar' | 'enum' | 'message' | 'any' | 'repeated' | 'map' | 'bytes';

export interface FieldNode {
  id: number;
  name: string;
  kind: FieldKind;
  type: string;
  value?: any;
  rawValue?: number | string;
  fields?: FieldNode[];
  items?: FieldNode[];
  childType?: string;
  anyType?: string;
}

export interface MessageTree {
  messageType: string;
  fields: FieldNode[];
}

/**
 * Build field tree from a protobufjs message object + its Type descriptor.
 * Pass root to enable google.protobuf.Any nested decoding.
 */
export async function buildFieldTree(
  msg: protobuf.Message | protobuf.Message[],
  type: protobuf.Type,
  root?: protobuf.Root
): Promise<MessageTree | MessageTree[]> {
  if (Array.isArray(msg)) {
    const trees: MessageTree[] = [];
    for (let i = 0; i < msg.length; i++) {
      trees.push({
        messageType: `${type.name}[${i}]`,
        fields: await buildFields(msg[i], type, root),
      });
    }
    return trees;
  }
  return {
    messageType: type.fullName.replace(/^\./, ''),
    fields: await buildFields(msg, type, root),
  };
}

async function buildFields(
  msg: protobuf.Message,
  type: protobuf.Type,
  root?: protobuf.Root
): Promise<FieldNode[]> {
  const nodes: FieldNode[] = [];
  for (const field of type.fieldsArray) {
    const node = await buildFieldNode(msg, field, root);
    nodes.push(node);
  }
  // Sort by field id
  nodes.sort((a, b) => a.id - b.id);
  return nodes;
}

async function buildFieldNode(
  msg: protobuf.Message,
  field: protobuf.Field,
  root?: protobuf.Root
): Promise<FieldNode> {
  const val = (msg as any)[field.name];
  const isRepeated = field.repeated;
  const isMap = field.map;

  if (isMap) {
    const mapType = field.resolvedType as protobuf.Type;
    const items: FieldNode[] = [];
    if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (mapType) {
          items.push({
            id: field.id,
            name: k,
            kind: 'message',
            type: mapType.fullName.replace(/^\./, ''),
            fields: await buildFields(v as protobuf.Message, mapType, root),
          } as FieldNode);
        } else {
          items.push({
            id: field.id,
            name: k,
            kind: 'scalar',
            type: typeof v,
            value: v,
          } as FieldNode);
        }
      }
    }
    return {
      id: field.id,
      name: field.name,
      kind: 'map',
      type: field.type,
      items,
    };
  }

  if (isRepeated) {
    const items: FieldNode[] = [];
    const arr = Array.isArray(val) ? val : [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      // Check for Any in repeated message
      if (field.resolvedType instanceof protobuf.Type && isAnyType(field.resolvedType)) {
        items.push(await buildAnyNode(field.id, `[${i}]`, item, root));
      } else if (field.resolvedType instanceof protobuf.Enum) {
        const enumType = field.resolvedType;
        items.push({
          id: field.id,
          name: `[${i}]`,
          kind: 'enum',
          type: enumType.fullName.replace(/^\./, ''),
          value: item,
          rawValue: item,
        } as FieldNode);
      } else if (field.resolvedType instanceof protobuf.Type) {
        items.push({
          id: field.id,
          name: `[${i}]`,
          kind: 'message',
          type: field.resolvedType.fullName.replace(/^\./, ''),
          fields: await buildFields(item, field.resolvedType, root),
        } as FieldNode);
      } else if (field.type === 'bytes') {
        items.push({
          id: field.id,
          name: `[${i}]`,
          kind: 'bytes',
          type: 'bytes',
          value: bytesToBase64(item),
          rawValue: item ? item.length : 0,
        } as FieldNode);
      } else {
        items.push({
          id: field.id,
          name: `[${i}]`,
          kind: 'scalar',
          type: field.type,
          value: longToValue(item),
        } as FieldNode);
      }
    }
    return {
      id: field.id,
      name: field.name,
      kind: 'repeated',
      type: field.type,
      items,
    };
  }

  // Singular field

  // Check for google.protobuf.Any
  if (field.resolvedType instanceof protobuf.Type && isAnyType(field.resolvedType)) {
    return buildAnyNode(field.id, field.name, val, root);
  }

  if (field.resolvedType instanceof protobuf.Enum) {
    const enumType = field.resolvedType;
    const enumName = enumType.valuesById[val as number];
    return {
      id: field.id,
      name: field.name,
      kind: 'enum',
      type: enumType.fullName.replace(/^\./, ''),
      value: enumName || val,
      rawValue: val as number,
    };
  }

  if (field.resolvedType instanceof protobuf.Type) {
    return {
      id: field.id,
      name: field.name,
      kind: 'message',
      type: field.resolvedType.fullName.replace(/^\./, ''),
      fields: val ? await buildFields(val, field.resolvedType, root) : [],
    };
  }

  if (field.type === 'bytes') {
    return {
      id: field.id,
      name: field.name,
      kind: 'bytes',
      type: 'bytes',
      value: bytesToBase64(val),
      rawValue: val ? val.length : 0,
    };
  }

  return {
    id: field.id,
    name: field.name,
    kind: 'scalar',
    type: field.type,
    value: longToValue(val),
  };
}

/** Check if a Type is google.protobuf.Any */
function isAnyType(type: protobuf.Type): boolean {
  return type.fullName === '.google.protobuf.Any';
}

/** Build a FieldNode for a google.protobuf.Any, decoding the nested message. */
async function buildAnyNode(
  id: number,
  name: string,
  val: any,
  root?: protobuf.Root
): Promise<FieldNode> {
  if (!val || !val.type_url) {
    return {
      id,
      name,
      kind: 'any',
      type: 'google.protobuf.Any',
      fields: [],
    };
  }

  const typeUrl: string = val.type_url;
  // Extract message type name from type_url (e.g., "type.googleapis.com/apis.Xxx" → "apis.Xxx")
  const typeName = typeUrl.split('/').pop() || '';
  const valueBytes = val.value;

  // Try to look up the type in the root and decode
  if (root && typeName && valueBytes && valueBytes.length > 0) {
    try {
      const innerType = root.lookupType(typeName);
      const innerMsg = innerType.decode(valueBytes);
      const innerFields = await buildFields(innerMsg, innerType, root);
      return {
        id,
        name,
        kind: 'any',
        type: 'google.protobuf.Any',
        anyType: typeName,
        fields: innerFields,
      };
    } catch {
      // Type not found in root, or decode failed — fall through to raw display
    }
  }

  // Fallback: show type_url + raw value
  return {
    id,
    name,
    kind: 'any',
    type: 'google.protobuf.Any',
    anyType: typeName,
    fields: [
      {
        id: 1,
        name: 'type_url',
        kind: 'scalar' as FieldKind,
        type: 'string',
        value: typeUrl,
      },
      {
        id: 2,
        name: 'value',
        kind: 'bytes' as FieldKind,
        type: 'bytes',
        value: bytesToBase64(valueBytes),
        rawValue: valueBytes ? valueBytes.length : 0,
      },
    ],
  };
}

function bytesToBase64(val: any): string | undefined {
  if (!val) return undefined;
  if (val instanceof Uint8Array) {
    return Buffer.from(val).toString('base64');
  }
  return String(val);
}

function longToValue(val: any): any {
  if (val == null) return undefined;
  // Long objects — convert to number if safe, otherwise string
  if (typeof val === 'object' && typeof val.toNumber === 'function') {
    const num = val.toNumber();
    if (Number.isSafeInteger(num)) return num;
    return val.toString();
  }
  return val;
}

/**
 * Render a MessageTree to a human-readable text tree for CLI output.
 */
export function renderTree(tree: MessageTree | MessageTree[], indent = ''): string {
  if (Array.isArray(tree)) {
    return tree.map((t, i) => `[${i}]\n${renderTree(t, indent + '  ')}`).join('\n');
  }
  const lines: string[] = [`${indent}${tree.messageType} (message)`];
  for (const f of tree.fields) {
    lines.push(renderField(f, indent + '├─ '));
  }
  return lines.join('\n');
}

function renderField(f: FieldNode, indent: string): string {
  const nameWithId = f.name.charAt(0) === '[' ? f.name : `${f.name}#${f.id}`;
  switch (f.kind) {
    case 'scalar':
      if (f.value == null || f.value === undefined) return `${indent}${nameWithId} (${f.type}) (unset)`;
      if (typeof f.value === 'string') return `${indent}${nameWithId} (${f.type}) = "${f.value}"`;
      return `${indent}${nameWithId} (${f.type}) = ${f.value}`;
    case 'enum':
      if (f.rawValue == null || f.rawValue === undefined) return `${indent}${nameWithId} (enum ${f.type}) (unset)`;
      return `${indent}${nameWithId} (enum ${f.type}) = ${f.rawValue} (${f.value})`;
    case 'bytes':
      if (!f.value) return `${indent}${nameWithId} (bytes) (unset)`;
      return `${indent}${nameWithId} (bytes, ${f.rawValue || 0}B) = ${f.value.slice(0, 60)}`;
    case 'any':
      if (f.anyType) {
        if (f.fields && f.fields.length > 0) {
          const childLines = f.fields.map(cf => renderField(cf, indent.replace(/├─/, '│  ') + '├─ '));
          return `${indent}${nameWithId} (Any → ${f.anyType})\n${childLines.join('\n')}`;
        }
        return `${indent}${nameWithId} (Any → ${f.anyType}) (unset)`;
      }
      return `${indent}${nameWithId} (Any) (unset)`;
    case 'message':
      if (!f.fields || f.fields.length === 0) return `${indent}${nameWithId} (${f.type}) (unset)`;
      const childLines = f.fields.map(cf => renderField(cf, indent.replace(/├─/, '│  ') + '├─ '));
      return `${indent}${nameWithId} (${f.type})\n${childLines.join('\n')}`;
    case 'repeated':
      if (!f.items || f.items.length === 0) return `${indent}${nameWithId} (repeated ${f.type}) []`;
      const itemLines = f.items.map(it => renderField(it, indent.replace(/├─/, '│  ') + '├─ '));
      return `${indent}${nameWithId} (repeated ${f.type})\n${itemLines.join('\n')}`;
    case 'map':
      if (!f.items || f.items.length === 0) return `${indent}${nameWithId} (map) {}`;
      const mapLines = f.items.map(it => renderField(it, indent.replace(/├─/, '│  ') + '├─ '));
      return `${indent}${nameWithId} (map)\n${mapLines.join('\n')}`;
    default:
      return `${indent}${nameWithId} (${f.type})`;
  }
}

function formatValue(v: any): string {
  if (v == null) return '(unset)';
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// --- Collapsed rendering (default for CLI) ---

export function renderTreeCollapsed(tree: MessageTree | MessageTree[]): string {
  if (Array.isArray(tree)) {
    return tree.map((t, i) => `[${i}]\n${renderTreeCollapsed(t)}`).join('\n');
  }
  const lines: string[] = [`${tree.messageType} (message)`];
  for (const f of tree.fields) {
    lines.push(renderFieldCollapsed(f, '├─ '));
  }
  return lines.join('\n');
}

function renderFieldCollapsed(f: FieldNode, indent: string): string {
  const nameWithId = f.name.charAt(0) === '[' ? f.name : `${f.name}#${f.id}`;
  switch (f.kind) {
    case 'scalar':
      if (f.value == null || f.value === undefined) return `${indent}${nameWithId} (${f.type}) (unset)`;
      if (typeof f.value === 'string') return `${indent}${nameWithId} (${f.type}) = "${truncate(f.value)}"`;
      return `${indent}${nameWithId} (${f.type}) = ${f.value}`;
    case 'enum':
      if (f.rawValue == null || f.rawValue === undefined) return `${indent}${nameWithId} (enum ${f.type}) (unset)`;
      return `${indent}${nameWithId} (enum ${f.type}) = ${f.rawValue} (${f.value})`;
    case 'bytes':
      if (!f.value) return `${indent}${nameWithId} (bytes) (unset)`;
      return `${indent}${nameWithId} (bytes, ${f.rawValue || 0}B) = ${truncate(f.value)}`;
    case 'any':
      if (f.anyType) {
        const n = f.fields ? f.fields.length : 0;
        if (n > 0) return `${indent}${nameWithId} (Any → ${f.anyType}, ${n} fields) ▸`;
        return `${indent}${nameWithId} (Any → ${f.anyType}) (unset)`;
      }
      return `${indent}${nameWithId} (Any) (unset)`;
    case 'message':
      if (!f.fields || f.fields.length === 0) return `${indent}${nameWithId} (${f.type}) (unset)`;
      return `${indent}${nameWithId} (${f.type}, ${f.fields.length} fields) ▸`;
    case 'repeated':
      if (!f.items || f.items.length === 0) return `${indent}${nameWithId} (repeated ${f.type}) []`;
      return `${indent}${nameWithId} (repeated ${f.type}, ${f.items.length} items) ▸`;
    case 'map':
      if (!f.items || f.items.length === 0) return `${indent}${nameWithId} (map) {}`;
      return `${indent}${nameWithId} (map, ${f.items.length} entries) ▸`;
    default:
      return `${indent}${nameWithId} (${f.type})`;
  }
}

// --- Path navigation (for --path flag) ---

import { parsePath, type PathSegment } from './path-nav';

export function navigatePath(tree: MessageTree | MessageTree[], path: string): MessageTree | null {
  const segments: PathSegment[] = parsePath(path);
  let current: any = Array.isArray(tree) ? tree[0] : tree;

  for (const seg of segments) {
    if (current == null) return null;
    if (typeof seg === 'number') {
      // Array index
      if (current.items && seg < current.items.length) {
        current = current.items[seg];
      } else if (Array.isArray(current) && seg < current.length) {
        current = current[seg];
      } else {
        return null;
      }
    } else {
      // Field name
      if (current.fields) {
        const found = current.fields.find((f: FieldNode) => f.name === seg);
        if (found) { current = found; } else { return null; }
      } else if (current.items && current.items.length > 0) {
        // Maybe navigating into first item of a repeated field
        const item = current.items[0];
        if (item.fields) {
          const found = item.fields.find((f: FieldNode) => f.name === seg);
          if (found) { current = found; } else { return null; }
        } else { return null; }
      } else {
        return null;
      }
    }
  }

  // Build a MessageTree from the found node
  if (current.fields) {
    return { messageType: current.type || current.anyType || current.name || 'unknown', fields: current.fields };
  }
  if (current.items) {
    return { messageType: `${current.type || current.name || 'unknown'} (repeated, ${current.items.length} items)`, fields: current.items };
  }
  // Scalar — single field
  return { messageType: current.type || current.name || 'scalar', fields: [current] };
}
