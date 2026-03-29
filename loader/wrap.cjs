'use strict';

/**
 * wrap.cjs — Core function instrumentation for Depct v2
 *
 * Wraps exported functions with telemetry. V2 enhancements:
 * - Enhanced error capture with causal chains
 * - Argument shapes at failure via serializeShape
 * - Preceding success context tracking
 * - Environment snapshot on error
 * - Source map resolution for stack traces
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serializeShape } = require('../shared/serialize.cjs');
const {
  generateErrorId,
  generateTraceId,
  generateSpanId,
  normalizeMessage,
  hashMessage,
} = require('../shared/fingerprint.cjs');
const { SCHEMA_VERSION } = require('../shared/schema.cjs');
const { currentContext, runWithContext, getCausalChain } = require('./trace-context.cjs');
const { parseStack } = require('./source-map.cjs');

const WRAPPED_MARKER = Symbol.for('depct.v2.wrapped');
const ORIGINAL_FN = Symbol.for('depct.v2.original');
const LOCATION_CACHE = new Map();

// ── Preceding success tracker ──
// Tracks last N successful arg shapes per nodeId for error context
const PRECEDING_SUCCESS_LIMIT = 5;
const precedingSuccesses = new Map(); // nodeId -> { count, shapes: CircularBuffer }

function recordSuccess(nodeId, argsShape) {
  let entry = precedingSuccesses.get(nodeId);
  if (!entry) {
    entry = { count: 0, shapes: [] };
    precedingSuccesses.set(nodeId, entry);
  }
  entry.count++;
  entry.shapes.push(argsShape);
  if (entry.shapes.length > PRECEDING_SUCCESS_LIMIT) {
    entry.shapes.shift();
  }

  // Prevent memory leak: cap tracked nodeIds
  if (precedingSuccesses.size > 5000) {
    const firstKey = precedingSuccesses.keys().next().value;
    precedingSuccesses.delete(firstKey);
  }
}

function getPrecedingSuccesses(nodeId) {
  const entry = precedingSuccesses.get(nodeId);
  if (!entry) return { count: 0, shapes: [] };
  return { count: entry.count, shapes: entry.shapes.slice() };
}

// ── Utility functions ──

function isClassLike(fn) {
  if (typeof fn !== 'function') return false;
  try {
    return Function.prototype.toString.call(fn).startsWith('class ');
  } catch {
    return false;
  }
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relativeFilePath(filePath, rootDir) {
  if (!filePath || !rootDir) return filePath || '<unknown>';
  const rel = path.relative(rootDir, filePath);
  if (!rel || rel.startsWith('../')) return toPosix(filePath);
  return toPosix(rel);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveFunctionLine(filePath, functionName) {
  if (!filePath || !functionName || filePath.startsWith('<')) return 0;

  const cacheKey = `${filePath}::${functionName}`;
  if (LOCATION_CACHE.has(cacheKey)) return LOCATION_CACHE.get(cacheKey);

  let line = 0;
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    const lines = source.split(/\r?\n/);
    const name = escapeRegExp(functionName);
    const patterns = [
      new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
      new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`),
      new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?function\\s*\\(`),
      new RegExp(`\\b${name}\\s*:\\s*(?:async\\s*)?\\(`),
      new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
    ];
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some((p) => p.test(lines[i]))) {
        line = i + 1;
        break;
      }
    }
  } catch {
    // no-op
  }

  LOCATION_CACHE.set(cacheKey, line);
  return line;
}

function buildNodeId({ relativeFile, functionName, line }) {
  const linePart = Number.isFinite(line) && line > 0 ? line : 0;
  return `${relativeFile}:${functionName}:${linePart}`;
}

function isPromiseLike(value) {
  if (value == null || typeof value.then !== 'function') return false;
  if (value instanceof Promise) return true;
  // Reject builder-pattern thenables (knex, Mongoose)
  if (
    typeof value.on === 'function' ||
    typeof value.where === 'function' ||
    typeof value.select === 'function' ||
    typeof value.toSQL === 'function'
  ) {
    return false;
  }
  return typeof value.catch === 'function';
}

function shouldSample(sampleRate) {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return Math.random() < sampleRate;
}

function hrtimeStart() {
  return process.hrtime.bigint();
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function nowIso() {
  return new Date().toISOString();
}

// ── Environment snapshot (captured on error) ──

function captureEnvironment() {
  try {
    const memUsage = process.memoryUsage();
    return {
      node_version: process.version,
      memory_rss_mb: Math.round(memUsage.rss / 1024 / 1024),
      event_loop_lag_ms: 0, // Placeholder; real lag requires perf_hooks integration
      uptime_seconds: Math.round(process.uptime()),
      platform: os.platform(),
      arch: os.arch(),
    };
  } catch {
    return {
      node_version: process.version,
      memory_rss_mb: 0,
      event_loop_lag_ms: 0,
      uptime_seconds: 0,
    };
  }
}

// ── Error event builder (v2.0 schema) ──

function buildErrorEvent({
  error,
  config,
  filePath,
  relativeFile,
  functionName,
  line,
  nodeId,
  args,
  spanId,
  traceId,
}) {
  const errorClass = error?.constructor?.name || error?.name || 'Error';
  const rawMessage = typeof error?.message === 'string' ? error.message : String(error);
  const normalizedMsg = normalizeMessage(rawMessage);
  const rawHash = hashMessage(rawMessage);
  const stackFrames = parseStack(error?.stack);

  // Causal chain from AsyncLocalStorage
  const causalChain = getCausalChain().map((node) => ({
    node_id: node.node_id,
    args_shape: node.args_shape || null,
  }));

  // Preceding success context
  const preceding = getPrecedingSuccesses(nodeId);

  const errorEvent = {
    schema_version: SCHEMA_VERSION,
    type: 'error',
    error_id: generateErrorId(),
    trace_id: traceId,
    span_id: spanId,
    timestamp: nowIso(),
    project_id: config.projectId,
    run_id: config.runId,

    error: {
      class: errorClass,
      message_normalized: normalizedMsg,
      message_raw_hash: rawHash,
      stack: stackFrames,
    },

    causal_chain: causalChain,

    trigger: {
      function: functionName,
      file: relativeFile,
      line,
      args_shape_at_failure: serializeShape(args),
      args_shape_when_succeeds:
        preceding.shapes.length > 0 ? preceding.shapes[preceding.shapes.length - 1] : null,
    },

    context: captureEnvironment(),

    preceding_successes: preceding.count,
    preceding_success_shapes: preceding.shapes,
  };

  return errorEvent;
}

// ── Core instrumentation ──

function instrumentFunction(fn, options) {
  if (typeof fn !== 'function') return fn;
  if (fn[WRAPPED_MARKER]) return fn;
  if (isClassLike(fn)) return fn;

  const {
    config,
    filePath,
    functionName,
    transport,
    hooks,
  } = options;

  const line = resolveFunctionLine(filePath, functionName);
  const relativeFile = relativeFilePath(filePath, config.rootDir);
  const nodeId = buildNodeId({ relativeFile, functionName, line });

  const wrapped = function depctV2Wrapped(...args) {
    const start = hrtimeStart();
    const parent = currentContext();
    const spanId = generateSpanId();
    const traceId = parent?.traceId || parent?.requestId || generateTraceId();
    const parentSpanId = parent?.spanId;

    const sampled = shouldSample(config.sampleRate);

    // Serialize args shape once — reused for span.start, causal chain, and error events
    let argsShape;
    try { argsShape = serializeShape(args); } catch { argsShape = null; }

    // Dispatch function.call hook
    if (hooks) {
      try {
        hooks.dispatch('function.call', {
          functionName,
          filePath: relativeFile,
          line,
          nodeId,
          spanId,
          traceId,
          args,
        });
      } catch { /* fail-open */ }
    }

    // Emit span.start
    if (sampled && transport) {
      try {
        transport.enqueue({
          schema_version: SCHEMA_VERSION,
          type: 'span.start',
          span_id: spanId,
          parent_span_id: parentSpanId,
          trace_id: traceId,
          timestamp: nowIso(),
          project_id: config.projectId,
          run_id: config.runId,
          node_id: nodeId,
          function_name: functionName,
          file: relativeFile,
          line,
          status: 'started',
          args_shape: argsShape,
        });
      } catch { /* fail-open */ }
    }

    let finishPublished = false;

    const publishFinish = (returnValue, error) => {
      if (finishPublished) return;
      finishPublished = true;

      try {
        const durationMs = elapsedMs(start);

        if (error) {
          // Record error via hooks
          if (hooks) {
            try {
              hooks.dispatch('function.error', error, {
                functionName,
                filePath: relativeFile,
                line,
                nodeId,
                spanId,
                traceId,
                args,
                durationMs,
              });
            } catch { /* fail-open */ }
          }

          // Build and emit full v2 error event (priority transport)
          if (transport) {
            try {
              const errorEvent = buildErrorEvent({
                error,
                config,
                filePath,
                relativeFile,
                functionName,
                line,
                nodeId,
                args,
                spanId,
                traceId,
              });
              transport.enqueue(errorEvent);
            } catch { /* fail-open */ }
          }
        } else {
          // Track success for preceding-success context (reuse cached argsShape)
          try {
            recordSuccess(nodeId, argsShape);
          } catch { /* fail-open */ }

          // Dispatch function.return hook
          if (hooks) {
            try {
              hooks.dispatch('function.return', returnValue, {
                functionName,
                filePath: relativeFile,
                line,
                nodeId,
                spanId,
                traceId,
                durationMs,
              });
            } catch { /* fail-open */ }
          }
        }

        // Emit span.finish for sampled calls
        if (sampled && transport) {
          const isError = Boolean(error);
          transport.enqueue({
            schema_version: SCHEMA_VERSION,
            type: 'span.finish',
            span_id: spanId,
            parent_span_id: parentSpanId,
            trace_id: traceId,
            timestamp: nowIso(),
            project_id: config.projectId,
            run_id: config.runId,
            node_id: nodeId,
            function_name: functionName,
            file: relativeFile,
            line,
            status: isError ? 'error' : 'ok',
            is_error: isError,
            duration_ms: Number(durationMs.toFixed(3)),
            return_shape: isError ? undefined : serializeShape(returnValue),
            error_class: isError ? (error?.constructor?.name || 'Error') : undefined,
            error_message_normalized: isError ? normalizeMessage(error?.message || '') : undefined,
          });
        }
      } catch {
        // Fail-open: telemetry must never break the host app
      }
    };

    const invoke = () => {
      try {
        const result = fn.apply(this, args);

        if (isPromiseLike(result)) {
          return result.then(
            (value) => { publishFinish(value, undefined); return value; },
            (err) => { publishFinish(undefined, err); throw err; }
          );
        }

        publishFinish(result, undefined);
        return result;
      } catch (err) {
        publishFinish(undefined, err);
        throw err;
      }
    };

    return runWithContext(
      { spanId, traceId, requestId: traceId, nodeId, argsShape },
      invoke
    );
  };

  // ── Preserve original function identity ──

  Object.defineProperty(wrapped, WRAPPED_MARKER, {
    configurable: false, enumerable: false, value: true, writable: false,
  });
  Object.defineProperty(wrapped, ORIGINAL_FN, {
    configurable: false, enumerable: false, value: fn, writable: false,
  });

  try {
    Object.defineProperty(wrapped, 'name', { configurable: true, value: fn.name });
  } catch { /* non-configurable */ }

  if (fn.prototype !== undefined) {
    wrapped.prototype = fn.prototype;
  }

  // Copy own properties
  const SKIP_PROPS = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);
  for (const prop of Object.getOwnPropertyNames(fn)) {
    if (SKIP_PROPS.has(prop)) continue;
    try {
      Object.defineProperty(wrapped, prop, Object.getOwnPropertyDescriptor(fn, prop));
    } catch { /* skip */ }
  }
  for (const sym of Object.getOwnPropertySymbols(fn)) {
    if (sym === WRAPPED_MARKER || sym === ORIGINAL_FN) continue;
    try {
      Object.defineProperty(wrapped, sym, Object.getOwnPropertyDescriptor(fn, sym));
    } catch { /* skip */ }
  }

  return wrapped;
}

function wrapExportedMembers(moduleExports, options) {
  if (typeof moduleExports === 'function') {
    const functionName = options.functionName || moduleExports.name || 'default';
    return instrumentFunction(moduleExports, { ...options, functionName });
  }

  if (!moduleExports || typeof moduleExports !== 'object') {
    return moduleExports;
  }

  let needsNewObject = false;
  const keys = Object.keys(moduleExports);

  for (const key of keys) {
    const value = moduleExports[key];
    if (typeof value !== 'function') continue;

    const wrapped = instrumentFunction(value, { ...options, functionName: key });
    try {
      moduleExports[key] = wrapped;
      if (moduleExports[key] !== wrapped) {
        needsNewObject = true;
        break;
      }
    } catch {
      needsNewObject = true;
      break;
    }
  }

  if (needsNewObject) {
    const proxy = Object.create(null);
    for (const key of keys) {
      const value = moduleExports[key];
      if (typeof value === 'function') {
        proxy[key] = instrumentFunction(value, { ...options, functionName: key });
      } else {
        proxy[key] = value;
      }
    }
    if (moduleExports.__esModule) proxy.__esModule = true;
    return proxy;
  }

  return moduleExports;
}

function isWrappedFunction(fn) {
  return Boolean(fn && fn[WRAPPED_MARKER]);
}

module.exports = {
  instrumentFunction,
  isWrappedFunction,
  wrapExportedMembers,
  buildErrorEvent,
  captureEnvironment,
};
