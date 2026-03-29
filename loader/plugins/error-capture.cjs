'use strict';

/**
 * error-capture.cjs — Enhanced error capture plugin for Depct v2
 *
 * Captures rich error events with:
 * - Causal chains from AsyncLocalStorage
 * - Argument shapes at the point of failure
 * - Preceding success context (what worked before it broke)
 * - Environment snapshots (memory, uptime, Node version)
 *
 * This plugin enhances the base error events emitted by wrap.cjs
 * with additional process-level error monitoring (uncaught exceptions,
 * unhandled rejections).
 */

const { serializeShape } = require('../../shared/serialize.cjs');
const {
  generateErrorId,
  generateTraceId,
  normalizeMessage,
  hashMessage,
} = require('../../shared/fingerprint.cjs');
const { SCHEMA_VERSION } = require('../../shared/schema.cjs');
const { currentContext, getCausalChain } = require('../trace-context.cjs');
const { parseStack } = require('../source-map.cjs');
const { captureEnvironment } = require('../wrap.cjs');

let _config = null;
let _transport = null;
let _installed = false;

module.exports = {
  name: 'error-capture',
  version: '1.0.0',

  shouldActivate(config) {
    return config.errorCapture !== false;
  },

  activate(hooks, { config, transport }) {
    _config = config;
    _transport = transport;

    // ── Enhance function errors with extra context ──
    hooks.onFunctionError((error, context) => {
      // The core wrap.cjs already emits error events.
      // This plugin adds process-level error capture below.
      // Hook dispatch allows plugins to react to errors for
      // custom processing (logging, metrics, etc.)
    });

    // ── Process-level error capture ──
    if (!_installed) {
      _installed = true;
      installProcessErrorHandlers(config, transport);
    }
  },
};

function installProcessErrorHandlers(config, transport) {
  // Uncaught exception handler
  process.on('uncaughtException', (error, origin) => {
    try {
      const ctx = currentContext();
      const traceId = ctx?.traceId || generateTraceId();
      const causalChain = getCausalChain();

      const errorEvent = {
        schema_version: SCHEMA_VERSION,
        type: 'error',
        error_id: generateErrorId(),
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        project_id: config.projectId,
        run_id: config.runId,

        error: {
          class: error?.constructor?.name || 'Error',
          message_normalized: normalizeMessage(error?.message || ''),
          message_raw_hash: hashMessage(error?.message || ''),
          stack: parseStack(error?.stack),
        },

        causal_chain: causalChain.map((n) => ({
          node_id: n.node_id,
          args_shape: n.args_shape || null,
        })),

        trigger: {
          function: '<uncaughtException>',
          file: '<process>',
          line: 0,
          args_shape_at_failure: null,
          args_shape_when_succeeds: null,
        },

        context: {
          ...captureEnvironment(),
          origin,
        },

        preceding_successes: 0,
        preceding_success_shapes: [],
      };

      transport.enqueue(errorEvent);
    } catch {
      // Fail-open: never make a crash worse
    }
  });

  // Unhandled promise rejection handler
  process.on('unhandledRejection', (reason, promise) => {
    try {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      const ctx = currentContext();
      const traceId = ctx?.traceId || generateTraceId();
      const causalChain = getCausalChain();

      const errorEvent = {
        schema_version: SCHEMA_VERSION,
        type: 'error',
        error_id: generateErrorId(),
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        project_id: config.projectId,
        run_id: config.runId,

        error: {
          class: error?.constructor?.name || 'Error',
          message_normalized: normalizeMessage(error?.message || ''),
          message_raw_hash: hashMessage(error?.message || ''),
          stack: parseStack(error?.stack),
        },

        causal_chain: causalChain.map((n) => ({
          node_id: n.node_id,
          args_shape: n.args_shape || null,
        })),

        trigger: {
          function: '<unhandledRejection>',
          file: '<process>',
          line: 0,
          args_shape_at_failure: null,
          args_shape_when_succeeds: null,
        },

        context: {
          ...captureEnvironment(),
          origin: 'unhandledRejection',
        },

        preceding_successes: 0,
        preceding_success_shapes: [],
      };

      transport.enqueue(errorEvent);
    } catch {
      // Fail-open
    }
  });
}
