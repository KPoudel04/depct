'use strict';

/**
 * trace-context.cjs — AsyncLocalStorage-based request context for Depct v2
 *
 * Propagates trace context (spanId, traceId, requestId, causal chain)
 * through async boundaries. The causal chain builder accumulates node IDs
 * along the call path from HTTP entry to failure point.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const contextStorage = new AsyncLocalStorage();

/**
 * Get the current trace context, or null if outside a traced scope.
 */
function currentContext() {
  return contextStorage.getStore() || null;
}

/**
 * Run a function within a new trace context.
 * The context inherits the parent's traceId/requestId and extends the causal chain.
 *
 * @param {object} ctx - Context fields: { spanId, traceId, requestId, nodeId, argsShape }
 * @param {function} fn - Function to execute within this context
 * @returns {*} The return value of fn
 */
function runWithContext(ctx, fn) {
  const parent = currentContext();

  // Build the causal chain by appending the current node with its args shape
  const parentChain = parent ? (parent.causalChain || []) : [];
  const chain = ctx.nodeId
    ? [...parentChain, { node_id: ctx.nodeId, span_id: ctx.spanId, args_shape: ctx.argsShape || null }]
    : parentChain;

  const store = {
    spanId: ctx.spanId,
    traceId: ctx.traceId || ctx.requestId,
    requestId: ctx.requestId || ctx.traceId,
    nodeId: ctx.nodeId,
    causalChain: chain,
    parentSpanId: parent ? parent.spanId : undefined,
    depth: (parent ? parent.depth : 0) + 1,
  };

  return contextStorage.run(store, fn);
}

/**
 * Extract the causal chain from the current context.
 * Returns an array of { node_id, span_id } objects representing
 * the ordered call path from the request entry to the current point.
 */
function getCausalChain() {
  const ctx = currentContext();
  if (!ctx) return [];
  return ctx.causalChain || [];
}

/**
 * Get the current trace depth (how many nested contexts deep we are).
 */
function getTraceDepth() {
  const ctx = currentContext();
  return ctx ? ctx.depth : 0;
}

module.exports = {
  currentContext,
  runWithContext,
  getCausalChain,
  getTraceDepth,
};
