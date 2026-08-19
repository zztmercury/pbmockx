/**
 * JSON path navigation — parse "a.b[0].c" into segments, then get/set.
 *
 * Works on both protobufjs message objects and plain JS objects because
 * protobufjs message fields are accessible via normal property access.
 */

const PATH_SEG_RE = /([^\[\].]+)|\[(\d+)\]/g;

export type PathSegment = string | number;

export function parsePath(path: string): PathSegment[] {
  const parts: PathSegment[] = [];
  let m: RegExpExecArray | null;
  PATH_SEG_RE.lastIndex = 0;
  while ((m = PATH_SEG_RE.exec(path)) !== null) {
    if (m[1] !== undefined) parts.push(m[1]);
    else if (m[2] !== undefined) parts.push(parseInt(m[2], 10));
  }
  return parts;
}

export function getByPath(obj: any, parts: PathSegment[]): any {
  let cur = obj;
  for (const p of parts) cur = cur[p];
  return cur;
}

export function setByPath(obj: any, parts: PathSegment[], value: any): void {
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}

/** Append `value` to the array at `parts` (protobufjs repeated fields are plain arrays). */
export function appendByPath(obj: any, parts: PathSegment[], value: any): void {
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  const arr = cur[parts[parts.length - 1]];
  if (!Array.isArray(arr)) throw new Error(`path is not a repeated field: ${parts.join('.')}`);
  arr.push(value);
}

/** Insert `value` into the array at `parts` before `index` (negative counts from the end). */
export function insertByPath(obj: any, parts: PathSegment[], index: number, value: any): void {
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  const arr = cur[parts[parts.length - 1]];
  if (!Array.isArray(arr)) throw new Error(`path is not a repeated field: ${parts.join('.')}`);
  arr.splice(index, 0, value);
}

/** Remove the item at `index` from the array at `parts`. */
export function removeByPath(obj: any, parts: PathSegment[], index: number): void {
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  const arr = cur[parts[parts.length - 1]];
  if (!Array.isArray(arr)) throw new Error(`path is not a repeated field: ${parts.join('.')}`);
  if (index < 0 || index >= arr.length) throw new Error(`index ${index} out of range (length ${arr.length})`);
  arr.splice(index, 1);
}

/** Check whether a path exists in the object. */
export function hasPath(obj: any, parts: PathSegment[]): boolean {
  try {
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return false;
      cur = cur[p];
    }
    return true;
  } catch {
    return false;
  }
}
