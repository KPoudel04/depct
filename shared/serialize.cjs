'use strict';

/**
 * shared/serialize.cjs — Shape serialization for Depct v2
 * Extracts the structural "shape" of a value without capturing actual data.
 * Used to describe argument shapes at failure points for AI agent consumption.
 */

const MAX_SHAPE_DEPTH = 4;
const MAX_OBJECT_KEYS = 24;
const MAX_ARRAY_ITEMS = 8;

function shapeOf(value, depth, seen) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') {
    return t;
  }
  if (t === 'function') return 'function';

  if (depth >= MAX_SHAPE_DEPTH) {
    return Array.isArray(value) ? ['...'] : 'object';
  }

  if (value instanceof Date) return 'Date';
  if (value instanceof RegExp) return 'RegExp';
  if (value instanceof Error) return `Error(${value.name || 'Error'})`;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return 'Buffer';

  // Compact common Node.js objects that are noisy when fully serialized
  const ctor = value?.constructor?.name;
  if (ctor === 'IncomingMessage' || ctor === 'Http2ServerRequest') {
    return { __type: 'IncomingMessage', method: shapeOf(value.method, depth + 1, seen), url: shapeOf(value.url, depth + 1, seen), headers: 'object' };
  }
  if (ctor === 'ServerResponse' || ctor === 'Http2ServerResponse') {
    return { __type: 'ServerResponse' };
  }
  if (ctor === 'Socket' || ctor === 'TLSSocket') return 'Socket';
  if (ctor === 'ReadableState' || ctor === 'WritableState') return ctor;

  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_ARRAY_ITEMS).map((item) => shapeOf(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) entries.push('...');
    return entries;
  }

  if (t === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const out = {};
    const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
    for (const key of keys) {
      try {
        out[key] = shapeOf(value[key], depth + 1, seen);
      } catch {
        out[key] = 'unknown';
      }
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
      out.__truncated__ = true;
    }
    return out;
  }

  return 'unknown';
}

/**
 * Returns a JSON string representing the structural shape of a value.
 * Never throws. Returns '"unknown"' on error.
 */
function serializeShape(value) {
  try {
    return JSON.stringify(shapeOf(value, 0, new WeakSet()));
  } catch {
    return '"unknown"';
  }
}

/**
 * Returns a plain object representing the structural shape of a value.
 * Never throws. Returns 'unknown' on error.
 */
function shapeOfValue(value) {
  try {
    return shapeOf(value, 0, new WeakSet());
  } catch {
    return 'unknown';
  }
}

module.exports = {
  serializeShape,
  shapeOfValue,
};
