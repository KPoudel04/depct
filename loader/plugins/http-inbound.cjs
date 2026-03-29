'use strict';

/**
 * http-inbound.cjs — HTTP server request/response capture plugin for Depct v2
 *
 * Patches http.createServer and https.createServer to capture inbound
 * request/response pairs. Sets up trace context for the request lifecycle
 * so all downstream function calls are correlated to the request.
 */

const http = require('node:http');
const https = require('node:https');
const { serializeShape } = require('../../shared/serialize.cjs');
const { generateSpanId, generateTraceId } = require('../../shared/fingerprint.cjs');
const { SCHEMA_VERSION } = require('../../shared/schema.cjs');
const { runWithContext } = require('../trace-context.cjs');

const HTTP_PATCHED = Symbol.for('depct.v2.httpInboundPatched');

module.exports = {
  name: 'http-inbound',
  version: '1.0.0',

  shouldActivate(config) {
    return config.httpInbound !== false;
  },

  activate(hooks, { config, transport }) {
    if (global[HTTP_PATCHED]) return;
    global[HTTP_PATCHED] = true;

    patchCreateServer(http, config, transport, hooks);
    patchCreateServer(https, config, transport, hooks);
  },
};

function patchCreateServer(mod, config, transport, hooks) {
  if (!mod || !mod.createServer) return;
  if (mod.createServer[HTTP_PATCHED]) return;

  const original = mod.createServer;

  mod.createServer = function depctV2PatchedCreateServer(...args) {
    const server = original.apply(this, args);
    wrapServerEmit(server, config, transport, hooks);
    return server;
  };

  Object.defineProperty(mod.createServer, HTTP_PATCHED, {
    configurable: false, enumerable: false, writable: false, value: true,
  });
}

function wrapServerEmit(server, config, transport, hooks) {
  const originalEmit = server.emit;

  server.emit = function depctV2PatchedEmit(event, ...args) {
    if (event === 'request') {
      const [req, res] = args;
      if (req && res && !req.__depctV2Tracked) {
        trackRequest(req, res, config, transport, hooks);
      }
    }
    return originalEmit.apply(this, arguments);
  };
}

function hrtimeMs() {
  return process.hrtime.bigint();
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function trackRequest(req, res, config, transport, hooks) {
  req.__depctV2Tracked = true;

  const start = hrtimeMs();
  const spanId = generateSpanId();
  const requestId =
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    req.headers['x-trace-id'] ||
    generateTraceId();

  const method = (req.method || 'GET').toUpperCase();
  const url = req.url || '/';
  const pathOnly = url.split('?')[0];
  const nodeId = `http:${method}:${pathOnly}`;

  // Attach trace metadata to request for downstream
  req.__depctRequestId = requestId;
  req.__depctHttpMethod = method;
  req.__depctHttpPath = url;

  // Dispatch hook
  try {
    hooks.dispatch('http.request', {
      spanId,
      traceId: requestId,
      method,
      url,
      path: pathOnly,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'accept': req.headers['accept'],
      },
    });
  } catch { /* fail-open */ }

  // Emit span.start
  try {
    transport.enqueue({
      schema_version: SCHEMA_VERSION,
      type: 'span.start',
      span_id: spanId,
      parent_span_id: undefined,
      trace_id: requestId,
      timestamp: new Date().toISOString(),
      project_id: config.projectId,
      run_id: config.runId,
      node_id: nodeId,
      function_name: `${method} ${pathOnly}`,
      file: '<http-inbound>',
      line: 0,
      kind: 'route',
      http_method: method,
      http_path: url,
      status: 'started',
      request_shape: {
        method,
        path: url,
        content_type: req.headers['content-type'] || undefined,
        has_body: method !== 'GET' && method !== 'HEAD',
      },
    });
  } catch { /* fail-open */ }

  // Track response finish
  let finished = false;

  const emitFinish = () => {
    if (finished) return;
    finished = true;

    try {
      const durationMs = elapsedMs(start);
      const statusCode = res.statusCode || 200;
      const isError = statusCode >= 400;
      const contentType = typeof res.getHeader === 'function'
        ? res.getHeader('content-type')
        : undefined;

      // Dispatch hook
      try {
        hooks.dispatch('http.response', {
          spanId,
          traceId: requestId,
          method,
          url,
          path: pathOnly,
          statusCode,
          durationMs,
          contentType,
          isError,
        });
      } catch { /* fail-open */ }

      transport.enqueue({
        schema_version: SCHEMA_VERSION,
        type: 'span.finish',
        span_id: spanId,
        parent_span_id: undefined,
        trace_id: requestId,
        timestamp: new Date().toISOString(),
        project_id: config.projectId,
        run_id: config.runId,
        node_id: nodeId,
        function_name: `${method} ${pathOnly}`,
        file: '<http-inbound>',
        line: 0,
        kind: 'route',
        http_method: method,
        http_path: url,
        status: isError ? 'error' : 'ok',
        is_error: isError,
        duration_ms: Number(durationMs.toFixed(3)),
        client_status_code: statusCode,
        client_content_type: contentType,
      });
    } catch {
      // fail-open
    }
  };

  res.once('finish', emitFinish);
  res.once('close', () => {
    if (!res.writableEnded) emitFinish();
  });

  // Store trace context on the request object so downstream middleware
  // and handlers can pick it up for context propagation
  req.__depctContext = {
    spanId,
    traceId: requestId,
    requestId,
    nodeId,
  };
}
