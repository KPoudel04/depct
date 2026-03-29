'use strict';

/**
 * http-outbound.cjs — External HTTP call capture plugin for Depct v2
 *
 * Patches globalThis.fetch and http/https.request to capture outbound
 * HTTP calls (API calls, webhooks, etc.). Correlates outbound calls
 * to the parent request via trace context.
 */

const http = require('node:http');
const https = require('node:https');
const { generateSpanId, generateTraceId } = require('../../shared/fingerprint.cjs');
const { normalizeMessage } = require('../../shared/fingerprint.cjs');
const { SCHEMA_VERSION } = require('../../shared/schema.cjs');
const { currentContext, runWithContext } = require('../trace-context.cjs');

const FETCH_PATCHED = Symbol.for('depct.v2.fetchPatched');
const HTTP_OUT_PATCHED = Symbol.for('depct.v2.httpOutPatched');

module.exports = {
  name: 'http-outbound',
  version: '1.0.0',

  shouldActivate(config) {
    return config.httpOutbound !== false;
  },

  activate(hooks, { config, transport }) {
    patchFetch(config, transport, hooks);
    patchHttpRequest(http, config, transport, hooks);
    patchHttpRequest(https, config, transport, hooks);
  },
};

// ── Helpers ──

function hrtimeMs() {
  return process.hrtime.bigint();
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function extractUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  if (input && typeof input.href === 'string') return input.href;
  return '<unknown>';
}

function extractMethod(input, init) {
  const fromInit = init && typeof init.method === 'string' ? init.method : undefined;
  const fromInput = input && typeof input.method === 'string' ? input.method : undefined;
  return String(fromInit || fromInput || 'GET').toUpperCase();
}

function safeTarget(urlString) {
  try {
    const parsed = new URL(urlString);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(urlString).split('?')[0];
  }
}

function isDepctInternal(input, init, config) {
  const url = extractUrl(input);
  const base = config.serverUrl.endsWith('/') ? config.serverUrl.slice(0, -1) : config.serverUrl;
  const evPath = config.eventsPath.startsWith('/') ? config.eventsPath : `/${config.eventsPath}`;
  const endpointUrl = `${base}${evPath}`;

  if (typeof url === 'string' && url.startsWith(endpointUrl)) return true;

  // Check for depct headers
  const headers = init?.headers || input?.headers;
  if (headers && typeof headers === 'object') {
    const normalized = {};
    if (typeof headers.forEach === 'function') {
      headers.forEach((v, k) => { normalized[String(k).toLowerCase()] = v; });
    } else if (!Array.isArray(headers)) {
      for (const [k, v] of Object.entries(headers)) {
        normalized[String(k).toLowerCase()] = v;
      }
    }
    if (normalized['x-depct-project-id'] || normalized['x-depct-run-id']) return true;
  }

  return false;
}

// ── Fetch patching ──

function patchFetch(config, transport, hooks) {
  if (typeof globalThis.fetch !== 'function') return;
  if (globalThis.fetch[FETCH_PATCHED]) return;

  const originalFetch = globalThis.fetch;

  const patchedFetch = function depctV2PatchedFetch(input, init) {
    const parent = currentContext();
    if (!parent || isDepctInternal(input, init, config)) {
      return originalFetch.apply(this, arguments);
    }

    const start = hrtimeMs();
    const method = extractMethod(input, init);
    const url = extractUrl(input);
    const target = safeTarget(url);

    const spanId = generateSpanId();
    const parentSpanId = parent?.spanId;
    const traceId = parent?.traceId || parent?.requestId || generateTraceId();
    const nodeId = `external:fetch:${method}:${target}`;

    // Dispatch hook
    try {
      hooks.dispatch('http.outbound.request', {
        spanId,
        traceId,
        method,
        url,
        target,
      });
    } catch { /* fail-open */ }

    // Emit span.start
    try {
      transport.enqueue({
        schema_version: SCHEMA_VERSION,
        type: 'span.start',
        span_id: spanId,
        parent_span_id: parentSpanId,
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        project_id: config.projectId,
        run_id: config.runId,
        node_id: nodeId,
        function_name: `fetch ${method} ${target}`,
        file: '<http-outbound>',
        line: 0,
        kind: 'external',
        http_method: method,
        http_path: target,
        status: 'started',
      });
    } catch { /* fail-open */ }

    return runWithContext(
      { spanId, traceId, requestId: traceId, nodeId },
      async () => {
        try {
          const response = await originalFetch.apply(this, arguments);
          const durationMs = elapsedMs(start);
          const isError = !response.ok;

          try {
            hooks.dispatch('http.outbound.response', {
              spanId,
              traceId,
              method,
              url,
              target,
              statusCode: response.status,
              durationMs,
              isError,
            });
          } catch { /* fail-open */ }

          try {
            transport.enqueue({
              schema_version: SCHEMA_VERSION,
              type: 'span.finish',
              span_id: spanId,
              parent_span_id: parentSpanId,
              trace_id: traceId,
              timestamp: new Date().toISOString(),
              project_id: config.projectId,
              run_id: config.runId,
              node_id: nodeId,
              function_name: `fetch ${method} ${target}`,
              file: '<http-outbound>',
              line: 0,
              kind: 'external',
              http_method: method,
              http_path: target,
              status: isError ? 'error' : 'ok',
              is_error: isError,
              duration_ms: Number(durationMs.toFixed(3)),
              external_status_code: response.status,
              error_class: isError ? 'HTTPError' : undefined,
              error_message_normalized: isError
                ? `fetch returned status ${response.status}`
                : undefined,
            });
          } catch { /* fail-open */ }

          return response;
        } catch (error) {
          const durationMs = elapsedMs(start);
          try {
            transport.enqueue({
              schema_version: SCHEMA_VERSION,
              type: 'span.finish',
              span_id: spanId,
              parent_span_id: parentSpanId,
              trace_id: traceId,
              timestamp: new Date().toISOString(),
              project_id: config.projectId,
              run_id: config.runId,
              node_id: nodeId,
              function_name: `fetch ${method} ${target}`,
              file: '<http-outbound>',
              line: 0,
              kind: 'external',
              http_method: method,
              http_path: target,
              status: 'error',
              is_error: true,
              duration_ms: Number(durationMs.toFixed(3)),
              error_class: error?.constructor?.name || 'Error',
              error_message_normalized: normalizeMessage(
                error?.message || String(error)
              ),
            });
          } catch { /* fail-open */ }
          throw error;
        }
      }
    );
  };

  Object.defineProperty(patchedFetch, FETCH_PATCHED, {
    configurable: false, enumerable: false, writable: false, value: true,
  });

  // Preserve any properties on the original fetch
  try {
    for (const prop of Object.getOwnPropertyNames(originalFetch)) {
      if (prop === 'length' || prop === 'name') continue;
      try {
        Object.defineProperty(patchedFetch, prop, Object.getOwnPropertyDescriptor(originalFetch, prop));
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  globalThis.fetch = patchedFetch;
}

// ── http/https.request patching ──

function patchHttpRequest(mod, config, transport, hooks) {
  if (!mod || !mod.request) return;
  if (mod.request[HTTP_OUT_PATCHED]) return;

  const originalRequest = mod.request;

  mod.request = function depctV2PatchedRequest(...args) {
    const parent = currentContext();
    if (!parent) {
      return originalRequest.apply(this, args);
    }

    // Parse the URL/options
    let url = '<unknown>';
    let method = 'GET';
    let target = '<unknown>';

    try {
      const firstArg = args[0];
      if (typeof firstArg === 'string') {
        url = firstArg;
        method = (args[1]?.method || 'GET').toUpperCase();
      } else if (firstArg && typeof firstArg === 'object') {
        if (firstArg.href) {
          url = firstArg.href;
        } else {
          const proto = firstArg.protocol || 'http:';
          const host = firstArg.hostname || firstArg.host || 'localhost';
          const port = firstArg.port ? `:${firstArg.port}` : '';
          const p = firstArg.path || '/';
          url = `${proto}//${host}${port}${p}`;
        }
        method = (firstArg.method || 'GET').toUpperCase();
      }
      target = safeTarget(url);
    } catch { /* fail-open */ }

    // Skip depct's own requests
    if (url.includes(config.serverUrl)) {
      return originalRequest.apply(this, args);
    }

    const start = hrtimeMs();
    const spanId = generateSpanId();
    const parentSpanId = parent?.spanId;
    const traceId = parent?.traceId || parent?.requestId || generateTraceId();
    const nodeId = `external:http:${method}:${target}`;

    // Emit span.start
    try {
      transport.enqueue({
        schema_version: SCHEMA_VERSION,
        type: 'span.start',
        span_id: spanId,
        parent_span_id: parentSpanId,
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        project_id: config.projectId,
        run_id: config.runId,
        node_id: nodeId,
        function_name: `http.request ${method} ${target}`,
        file: '<http-outbound>',
        line: 0,
        kind: 'external',
        http_method: method,
        http_path: target,
        status: 'started',
      });
    } catch { /* fail-open */ }

    const req = originalRequest.apply(this, args);

    let finished = false;

    const emitFinish = (statusCode, error) => {
      if (finished) return;
      finished = true;

      try {
        const durationMs = elapsedMs(start);
        const isError = Boolean(error) || (statusCode >= 400);

        transport.enqueue({
          schema_version: SCHEMA_VERSION,
          type: 'span.finish',
          span_id: spanId,
          parent_span_id: parentSpanId,
          trace_id: traceId,
          timestamp: new Date().toISOString(),
          project_id: config.projectId,
          run_id: config.runId,
          node_id: nodeId,
          function_name: `http.request ${method} ${target}`,
          file: '<http-outbound>',
          line: 0,
          kind: 'external',
          http_method: method,
          http_path: target,
          status: isError ? 'error' : 'ok',
          is_error: isError,
          duration_ms: Number(durationMs.toFixed(3)),
          external_status_code: statusCode,
          error_class: error ? (error?.constructor?.name || 'Error') : (isError ? 'HTTPError' : undefined),
          error_message_normalized: error
            ? normalizeMessage(error?.message || '')
            : (isError ? `http.request returned status ${statusCode}` : undefined),
        });
      } catch { /* fail-open */ }
    };

    req.on('response', (res) => {
      res.on('end', () => emitFinish(res.statusCode, null));
    });

    req.on('error', (err) => emitFinish(0, err));
    req.on('timeout', () => emitFinish(0, new Error('Request timeout')));

    return req;
  };

  Object.defineProperty(mod.request, HTTP_OUT_PATCHED, {
    configurable: false, enumerable: false, writable: false, value: true,
  });
}
