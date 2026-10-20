/**
 * Any expand/pack — recursively decode google.protobuf.Any fields
 * so patch path navigation works transparently through Any.
 *
 * Before patch: expandAny → msg.data becomes { type_url, value: decodedMsg }
 * After patch:  packAny → msg.data.value re-encoded back to bytes
 */

import protobuf from 'protobufjs';

function isAnyType(type: protobuf.Type): boolean {
  return type.fullName === '.google.protobuf.Any';
}

/**
 * Recursively expand all Any fields: decode value bytes into message objects.
 * After expand, msg[field].value is a message object (not Uint8Array).
 */
export async function expandAny(
  msg: any,
  type: protobuf.Type,
  root: protobuf.Root
): Promise<void> {
  for (const field of type.fieldsArray) {
    const val = msg[field.name];
    if (val == null) continue;

    if (field.resolvedType instanceof protobuf.Type && isAnyType(field.resolvedType)) {
      // Any field — decode value if present
      if (val.type_url && val.value && val.value.length > 0) {
        const typeName = val.type_url.split('/').pop();
        try {
          const innerType = root.lookupType(typeName);
          const innerMsg = innerType.decode(val.value);
          await expandAny(innerMsg, innerType, root);
          val.value = innerMsg;  // Replace bytes with decoded message
        } catch (e: any) {
          // Can't decode — leave as bytes
        }
      }
    } else if (field.resolvedType instanceof protobuf.Type) {
      // Nested message — recurse
      if (field.repeated && Array.isArray(val)) {
        for (const item of val) {
          if (item) await expandAny(item, field.resolvedType, root);
        }
      } else if (val) {
        await expandAny(val, field.resolvedType, root);
      }
    }
  }
}

/**
 * Recursively pack all expanded Any fields: re-encode message objects back to bytes.
 * After pack, msg[field].value is Uint8Array (ready for wire encoding).
 */
export async function packAny(
  msg: any,
  type: protobuf.Type,
  root: protobuf.Root
): Promise<void> {
  for (const field of type.fieldsArray) {
    const val = msg[field.name];
    if (val == null) continue;

    if (field.resolvedType instanceof protobuf.Type && isAnyType(field.resolvedType)) {
      // Any field — re-encode value if it's a message object
      if (val.type_url && val.value && typeof val.value === 'object' && !(val.value instanceof Uint8Array)) {
        const typeName = val.type_url.split('/').pop();
        try {
          const innerType = root.lookupType(typeName);
          await packAny(val.value, innerType, root);
          const encoded = innerType.encode(val.value).finish();
          val.value = Buffer.from(encoded);
        } catch (e: any) {
          // Can't re-encode — leave as is (will cause encode error)
        }
      }
    } else if (field.resolvedType instanceof protobuf.Type) {
      // Nested message — recurse
      if (field.repeated && Array.isArray(val)) {
        for (const item of val) {
          if (item) await packAny(item, field.resolvedType, root);
        }
      } else if (val) {
        await packAny(val, field.resolvedType, root);
      }
    }
  }
}
