'use strict';

/**
 * function-trace.cjs — Function call tracing plugin for Depct v2
 *
 * Emits span start/finish events for traced function calls.
 * Provides detailed timing and shape data for the call graph.
 * The core wrap.cjs handles the actual span emission; this plugin
 * adds call-graph analysis hooks and call frequency tracking.
 */

const { SCHEMA_VERSION } = require('../../shared/schema.cjs');

// ── Call frequency tracker ──
// Tracks call counts per nodeId for hot-path detection
const callCounts = new Map();
const CALL_COUNT_MAX_ENTRIES = 10000;

function incrementCallCount(nodeId) {
  const current = callCounts.get(nodeId) || 0;
  callCounts.set(nodeId, current + 1);

  // Prevent unbounded growth
  if (callCounts.size > CALL_COUNT_MAX_ENTRIES) {
    const firstKey = callCounts.keys().next().value;
    callCounts.delete(firstKey);
  }

  return current + 1;
}

// ── Slow call tracker ──
// Tracks p95-ish duration per nodeId for anomaly detection
const durationTrackers = new Map();
const DURATION_SAMPLES = 100;
const DURATION_MAX_ENTRIES = 5000;

function trackDuration(nodeId, durationMs) {
  let tracker = durationTrackers.get(nodeId);
  if (!tracker) {
    tracker = { samples: [], sorted: false };
    durationTrackers.set(nodeId, tracker);
  }

  tracker.samples.push(durationMs);
  tracker.sorted = false;

  if (tracker.samples.length > DURATION_SAMPLES) {
    tracker.samples.shift();
  }

  // Prevent unbounded growth
  if (durationTrackers.size > DURATION_MAX_ENTRIES) {
    const firstKey = durationTrackers.keys().next().value;
    durationTrackers.delete(firstKey);
  }
}

function getP95(nodeId) {
  const tracker = durationTrackers.get(nodeId);
  if (!tracker || tracker.samples.length < 5) return null;

  if (!tracker.sorted) {
    tracker.samples.sort((a, b) => a - b);
    tracker.sorted = true;
  }

  const idx = Math.floor(tracker.samples.length * 0.95);
  return tracker.samples[idx];
}

module.exports = {
  name: 'function-trace',
  version: '1.0.0',

  shouldActivate(config) {
    return config.functionTrace !== false;
  },

  activate(hooks, { config, transport }) {
    // Track every function call for frequency analysis
    hooks.onFunctionCall((context) => {
      try {
        const count = incrementCallCount(context.nodeId);

        // Annotate context with call count for downstream plugins
        context._callCount = count;
      } catch {
        // fail-open
      }
    });

    // Track function return for duration analysis
    hooks.onFunctionReturn((result, context) => {
      try {
        if (typeof context.durationMs === 'number') {
          trackDuration(context.nodeId, context.durationMs);

          // Check for anomalously slow calls
          const p95 = getP95(context.nodeId);
          if (p95 !== null && context.durationMs > p95 * 3 && context.durationMs > 100) {
            // Emit a slow-call warning event
            try {
              transport.enqueue({
                schema_version: SCHEMA_VERSION,
                type: 'warning',
                subtype: 'slow_call',
                timestamp: new Date().toISOString(),
                project_id: config.projectId,
                run_id: config.runId,
                trace_id: context.traceId,
                span_id: context.spanId,
                node_id: context.nodeId,
                function_name: context.functionName,
                file: context.filePath,
                line: context.line,
                duration_ms: context.durationMs,
                p95_ms: p95,
                ratio: Number((context.durationMs / p95).toFixed(2)),
              });
            } catch {
              // fail-open
            }
          }
        }
      } catch {
        // fail-open
      }
    });

    // Track errors for duration context
    hooks.onFunctionError((error, context) => {
      try {
        if (typeof context.durationMs === 'number') {
          trackDuration(context.nodeId, context.durationMs);
        }
      } catch {
        // fail-open
      }
    });
  },

  // Expose for testing
  _getCallCount(nodeId) {
    return callCounts.get(nodeId) || 0;
  },

  _getP95(nodeId) {
    return getP95(nodeId);
  },
};
