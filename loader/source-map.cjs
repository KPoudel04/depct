'use strict';

/**
 * source-map.cjs — Source map resolution for Depct v2
 *
 * Detects .map files adjacent to compiled output and resolves stack frame
 * positions to original source locations. No external services or dependencies.
 * Uses the VLQ decoding algorithm to parse source maps inline.
 */

const fs = require('node:fs');
const path = require('node:path');

// Cache parsed source maps to avoid re-reading files
const sourceMapCache = new Map();
const CACHE_MAX = 200;

// ── VLQ Decoding ──

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_TABLE = new Int32Array(128);
for (let i = 0; i < VLQ_CHARS.length; i++) {
  VLQ_TABLE[VLQ_CHARS.charCodeAt(i)] = i;
}

function decodeVLQ(encoded) {
  const values = [];
  let shift = 0;
  let value = 0;

  for (let i = 0; i < encoded.length; i++) {
    const charCode = encoded.charCodeAt(i);
    if (charCode >= 128) continue;
    const digit = VLQ_TABLE[charCode];
    const cont = digit & 32;
    value += (digit & 31) << shift;

    if (cont) {
      shift += 5;
    } else {
      const isNeg = value & 1;
      value >>= 1;
      values.push(isNeg ? -value : value);
      value = 0;
      shift = 0;
    }
  }

  return values;
}

// ── Source Map Parsing ──

function parseSourceMap(mapData) {
  if (!mapData || !mapData.mappings || !Array.isArray(mapData.sources)) {
    return null;
  }

  const sources = mapData.sources;
  const sourceRoot = mapData.sourceRoot || '';
  const lines = mapData.mappings.split(';');
  const segments = [];

  let generatedLine = 0;
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let nameIndex = 0;

  for (const line of lines) {
    generatedLine++;
    let generatedColumn = 0;

    if (!line) continue;

    const rawSegments = line.split(',');
    for (const raw of rawSegments) {
      if (!raw) continue;
      const values = decodeVLQ(raw);
      if (values.length < 4) continue;

      generatedColumn += values[0];
      sourceIndex += values[1];
      sourceLine += values[2];
      sourceColumn += values[3];
      if (values.length >= 5) nameIndex += values[4];

      segments.push({
        generatedLine,
        generatedColumn,
        sourceIndex,
        sourceLine: sourceLine + 1, // 1-based
        sourceColumn,
        nameIndex: values.length >= 5 ? nameIndex : -1,
      });
    }
  }

  return {
    sources,
    sourceRoot,
    names: mapData.names || [],
    segments,
  };
}

function loadSourceMap(filePath) {
  if (sourceMapCache.has(filePath)) {
    return sourceMapCache.get(filePath);
  }

  let parsed = null;

  try {
    // Check for adjacent .map file
    const mapPath = filePath + '.map';
    if (fs.existsSync(mapPath)) {
      const raw = fs.readFileSync(mapPath, 'utf8');
      const mapData = JSON.parse(raw);
      parsed = parseSourceMap(mapData);
    }
  } catch {
    // Fail-open: if we can't read the source map, return null
  }

  // Evict oldest entries if cache is full
  if (sourceMapCache.size >= CACHE_MAX) {
    const firstKey = sourceMapCache.keys().next().value;
    sourceMapCache.delete(firstKey);
  }

  sourceMapCache.set(filePath, parsed);
  return parsed;
}

/**
 * Resolve a generated position to an original source position.
 *
 * @param {string} filePath - Path to the generated file
 * @param {number} line - 1-based line number in generated file
 * @param {number} column - 0-based column number in generated file
 * @returns {{ file: string, line: number, column: number, function: string|null } | null}
 */
function resolvePosition(filePath, line, column) {
  try {
    const map = loadSourceMap(filePath);
    if (!map) return null;

    // Find the closest segment for the given generated position
    let best = null;
    for (const seg of map.segments) {
      if (seg.generatedLine === line) {
        if (seg.generatedColumn <= column) {
          if (!best || seg.generatedColumn > best.generatedColumn) {
            best = seg;
          }
        }
      } else if (seg.generatedLine < line) {
        if (!best || seg.generatedLine > best.generatedLine) {
          best = seg;
        }
      }
    }

    if (!best) return null;

    const sourceFile = map.sources[best.sourceIndex];
    if (!sourceFile) return null;

    const resolvedFile = map.sourceRoot
      ? path.resolve(path.dirname(filePath), map.sourceRoot, sourceFile)
      : path.resolve(path.dirname(filePath), sourceFile);

    return {
      file: resolvedFile,
      line: best.sourceLine,
      column: best.sourceColumn,
      function: best.nameIndex >= 0 ? (map.names[best.nameIndex] || null) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a V8 stack trace string into structured frames,
 * resolving source maps where available.
 *
 * @param {string} stack - Error.stack string
 * @returns {Array<{ file: string, line: number, column: number, function: string }>}
 */
function parseStack(stack) {
  if (typeof stack !== 'string') return [];

  const frames = [];
  const lines = stack.split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('at ')) continue;

    let fn = '<anonymous>';
    let file = '<unknown>';
    let line = 0;
    let column = 0;

    // Match "at functionName (file:line:column)"
    const matchParen = trimmed.match(
      /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/
    );
    // Match "at file:line:column"
    const matchBare = trimmed.match(
      /^at\s+(.+?):(\d+):(\d+)$/
    );

    if (matchParen) {
      fn = matchParen[1] || '<anonymous>';
      file = matchParen[2];
      line = parseInt(matchParen[3], 10);
      column = parseInt(matchParen[4], 10);
    } else if (matchBare) {
      file = matchBare[1];
      line = parseInt(matchBare[2], 10);
      column = parseInt(matchBare[3], 10);
    } else {
      continue;
    }

    // Skip internal Node.js frames
    if (file.startsWith('node:') || file.startsWith('internal/')) continue;

    // Attempt source map resolution
    const resolved = resolvePosition(file, line, column);
    if (resolved) {
      frames.push({
        file: resolved.file,
        line: resolved.line,
        column: resolved.column,
        function: resolved.function || fn,
      });
    } else {
      frames.push({ file, line, column, function: fn });
    }
  }

  return frames;
}

/**
 * Clear the source map cache (useful for testing).
 */
function clearCache() {
  sourceMapCache.clear();
}

module.exports = {
  parseStack,
  resolvePosition,
  clearCache,
};
