'use strict';

/**
 * db-patch.cjs — Database client patching plugin for Depct v2
 *
 * Patches query methods on popular database clients (pg, mysql2, better-sqlite3)
 * to capture query spans. Correlates queries to parent request traces.
 * Redacts SQL values, keeping only query structure.
 */

const Module = require('node:module');
const { serializeShape } = require('../../shared/serialize.cjs');
const { generateSpanId, generateTraceId, normalizeMessage } = require('../../shared/fingerprint.cjs');
const { SCHEMA_VERSION } = require('../../shared/schema.cjs');
const { currentContext } = require('../trace-context.cjs');

const DB_PATCHED = Symbol.for('depct.v2.dbPatched');

// ── SQL helpers ──

function redactSql(sql) {
  if (typeof sql !== 'string') return String(sql || '');
  return sql
    .replace(/'[^']*'/g, "'?'")
    .replace(/"[^"]*"/g, '"?"')
    .replace(/\b\d+\b/g, '?')
    .replace(/\$\d+/g, '?');
}

function extractTable(sql) {
  if (typeof sql !== 'string') return 'unknown';
  const match = sql.match(/(?:FROM|INTO|UPDATE|JOIN)\s+["'`]?(\w+)["'`]?/i);
  return match ? match[1] : 'unknown';
}

function extractOperation(sql) {
  if (typeof sql !== 'string') return 'QUERY';
  const match = sql.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|UPSERT)/i);
  return match ? match[1].toUpperCase() : 'QUERY';
}

function hrtimeMs() {
  return process.hrtime.bigint();
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

// ── Span emitter ──

function emitDbSpan(config, transport, hooks, { operation, table, queryShape, durationMs, error }) {
  const parent = currentContext();
  const spanId = generateSpanId();
  const traceId = parent?.traceId || parent?.requestId || generateTraceId();
  const nodeId = `db:${operation}:${table}`;

  const isError = Boolean(error);

  // Dispatch hook
  if (hooks) {
    try {
      if (isError) {
        hooks.dispatch('db.error', error, {
          spanId, traceId, operation, table, queryShape, durationMs,
        });
      } else {
        hooks.dispatch('db.result', {
          spanId, traceId, operation, table, queryShape, durationMs,
        });
      }
    } catch { /* fail-open */ }
  }

  try {
    const event = {
      schema_version: SCHEMA_VERSION,
      type: 'span.finish',
      span_id: spanId,
      parent_span_id: parent?.spanId,
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      project_id: config.projectId,
      run_id: config.runId,
      node_id: nodeId,
      function_name: `db.${operation.toLowerCase()}`,
      file: '<db>',
      line: 0,
      kind: 'db',
      status: isError ? 'error' : 'ok',
      is_error: isError,
      duration_ms: Number(durationMs.toFixed(3)),
      db_operation: operation,
      db_table: table,
      db_query_shape: queryShape,
      error_class: isError ? (error?.constructor?.name || 'Error') : undefined,
      error_message_normalized: isError
        ? normalizeMessage(error?.message || '')
        : undefined,
    };

    transport.enqueue(event);
  } catch {
    // fail-open
  }
}

// ── pg (node-postgres) ──

function patchPg(pg, config, transport, hooks) {
  const Client = pg.Client;
  if (!Client?.prototype?.query) return;

  const originalQuery = Client.prototype.query;

  Client.prototype.query = function depctV2PatchedPgQuery(...args) {
    const start = hrtimeMs();
    const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text || '');
    const operation = extractOperation(sql);
    const table = extractTable(sql);
    const queryShape = redactSql(sql);

    // Dispatch query hook
    if (hooks) {
      try {
        hooks.dispatch('db.query', { operation, table, queryShape, client: 'pg' });
      } catch { /* fail-open */ }
    }

    const result = originalQuery.apply(this, args);

    if (result && typeof result.then === 'function') {
      return result.then(
        (res) => {
          emitDbSpan(config, transport, hooks, {
            operation, table, queryShape, durationMs: elapsedMs(start),
          });
          return res;
        },
        (err) => {
          emitDbSpan(config, transport, hooks, {
            operation, table, queryShape, durationMs: elapsedMs(start), error: err,
          });
          throw err;
        }
      );
    }

    return result;
  };
}

// ── mysql2 ──

function patchMysql2(mysql2, config, transport, hooks) {
  // mysql2 exports both a Connection and a Pool.
  // Patch the prototype for both if available.
  const targets = [];

  if (mysql2.Connection?.prototype?.query) {
    targets.push(mysql2.Connection.prototype);
  }
  // Pool connections
  if (mysql2.Pool?.prototype?.query) {
    targets.push(mysql2.Pool.prototype);
  }
  // Also check for the default createConnection result prototype
  if (mysql2.createConnection) {
    // We patch Connection.prototype which covers createConnection results
  }

  for (const proto of targets) {
    const originalQuery = proto.query;

    proto.query = function depctV2PatchedMysqlQuery(sql, ...rest) {
      const start = hrtimeMs();
      const sqlText = typeof sql === 'string' ? sql : (sql?.sql || '');
      const operation = extractOperation(sqlText);
      const table = extractTable(sqlText);
      const queryShape = redactSql(sqlText);

      // Callback mode
      const lastArg = rest[rest.length - 1];
      if (typeof lastArg === 'function') {
        rest[rest.length - 1] = function (err, ...results) {
          emitDbSpan(config, transport, hooks, {
            operation, table, queryShape, durationMs: elapsedMs(start), error: err || undefined,
          });
          return lastArg.call(this, err, ...results);
        };
      }

      const result = originalQuery.call(this, sql, ...rest);

      // Promise mode
      if (result && typeof result.then === 'function' && typeof lastArg !== 'function') {
        return result.then(
          (res) => {
            emitDbSpan(config, transport, hooks, {
              operation, table, queryShape, durationMs: elapsedMs(start),
            });
            return res;
          },
          (err) => {
            emitDbSpan(config, transport, hooks, {
              operation, table, queryShape, durationMs: elapsedMs(start), error: err,
            });
            throw err;
          }
        );
      }

      return result;
    };
  }
}

// ── better-sqlite3 ──

function patchBetterSqlite3(Database, config, transport, hooks) {
  if (typeof Database !== 'function') return;
  if (!Database.prototype?.prepare) return;

  const originalPrepare = Database.prototype.prepare;

  Database.prototype.prepare = function depctV2PatchedPrepare(sql) {
    const stmt = originalPrepare.call(this, sql);
    const operation = extractOperation(sql);
    const table = extractTable(sql);
    const queryShape = redactSql(sql);

    for (const method of ['run', 'get', 'all']) {
      if (typeof stmt[method] !== 'function') continue;
      const original = stmt[method];

      stmt[method] = function (...args) {
        const start = hrtimeMs();
        try {
          const result = original.apply(this, args);
          emitDbSpan(config, transport, hooks, {
            operation, table, queryShape, durationMs: elapsedMs(start),
          });
          return result;
        } catch (err) {
          emitDbSpan(config, transport, hooks, {
            operation, table, queryShape, durationMs: elapsedMs(start), error: err,
          });
          throw err;
        }
      };
    }

    return stmt;
  };
}

// ── Plugin export ──

module.exports = {
  name: 'db-patch',
  version: '1.0.0',

  shouldActivate(config) {
    return config.dbCapture !== false;
  },

  activate(hooks, { config, transport }) {
    if (global[DB_PATCHED]) return;
    global[DB_PATCHED] = true;

    const originalLoad = Module._load;
    const patchedModules = new Set();

    const patchers = {
      pg: patchPg,
      mysql2: patchMysql2,
      'better-sqlite3': patchBetterSqlite3,
    };

    // Hook into Module._load to detect DB client loading
    const prevLoad = Module._load;

    Module._load = function depctV2DbPatchedLoad(request, parent, isMain) {
      const loaded = prevLoad.apply(this, arguments);

      if (patchers[request] && !patchedModules.has(request)) {
        patchedModules.add(request);
        try {
          patchers[request](loaded, config, transport, hooks);
          if (config.debug) {
            try {
              process.stderr.write(`[depct-loader] Patched ${request} for query capture.\n`);
            } catch { /* */ }
          }
        } catch {
          // fail-open
        }
      }

      return loaded;
    };

    // Preserve any markers from prior hooks
    const markerSym = Symbol.for('depct.v2.moduleHookInstalled');
    if (prevLoad[markerSym]) {
      try {
        Object.defineProperty(Module._load, markerSym, {
          configurable: false, enumerable: false, writable: false, value: true,
        });
      } catch { /* */ }
    }
  },
};
