'use strict';

/**
 * shared/db.cjs — SQLite database layer using sql.js (pure Wasm, zero native deps)
 *
 * Provides a better-sqlite3-compatible API surface:
 *   db.prepare(sql).run(...params)
 *   db.prepare(sql).get(...params)
 *   db.prepare(sql).all(...params)
 *   db.exec(sql)
 *   db.pragma(str)
 *
 * The database persists to disk via manual save() calls after writes.
 */

const fs = require('node:fs');
const path = require('node:path');

let SQL = null;
let sqlJsInitPromise = null;

function initSqlJs() {
  if (SQL) return Promise.resolve(SQL);
  if (sqlJsInitPromise) return sqlJsInitPromise;
  sqlJsInitPromise = require('sql.js')().then((sqlJs) => {
    SQL = sqlJs;
    return SQL;
  });
  return sqlJsInitPromise;
}

// Synchronous init — blocks on first call. Acceptable for CLI startup.
function initSqlJsSync() {
  if (SQL) return SQL;
  // sql.js ships a synchronous fallback via the wasm file
  const sqljs = require('sql.js');
  // Force synchronous by using the sync constructor if available,
  // otherwise we have to get creative
  if (SQL) return SQL;
  // The standard sql.js init is async. For the loader (which runs inside
  // the user's app), we need sync. We'll use a blocking approach.
  throw new Error('sql.js requires async init — use createDatabase() or createDatabaseSync()');
}

/**
 * Create or open a database at the given path.
 * Returns a db object with better-sqlite3-compatible API.
 * ASYNC — call with await.
 */
async function createDatabase(dbPath) {
  const sqlJs = await initSqlJs();
  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let fileBuffer = null;
  if (fs.existsSync(resolved)) {
    fileBuffer = fs.readFileSync(resolved);
  }

  const rawDb = fileBuffer ? new sqlJs.Database(fileBuffer) : new sqlJs.Database();
  return wrapDatabase(rawDb, resolved);
}

/**
 * Open a database synchronously (for the read-only CLI query path).
 * Uses a pre-initialized sql.js instance. Call ensureInit() first.
 */
function openDatabaseSync(dbPath, opts = {}) {
  if (!SQL) {
    throw new Error('sql.js not initialized. Call await ensureInit() first.');
  }
  const resolved = path.resolve(dbPath);
  if (opts.fileMustExist && !fs.existsSync(resolved)) {
    throw new Error(`Database file not found: ${resolved}`);
  }
  let fileBuffer = null;
  if (fs.existsSync(resolved)) {
    fileBuffer = fs.readFileSync(resolved);
  }
  const rawDb = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();
  return wrapDatabase(rawDb, resolved);
}

/**
 * Ensure sql.js is initialized. Must be called once before openDatabaseSync.
 */
async function ensureInit() {
  await initSqlJs();
}

/**
 * Wrap a sql.js Database with a better-sqlite3-compatible API.
 */
function wrapDatabase(rawDb, filePath) {
  let isDirty = false;

  function save() {
    if (!isDirty || !filePath) return;
    try {
      const data = rawDb.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
      isDirty = false;
    } catch (err) {
      try { process.stderr.write(`[depct-db] Save failed: ${err.message}\n`); } catch {}
    }
  }

  // Auto-save periodically for long-running processes (loader)
  let saveTimer = null;
  function startAutoSave(intervalMs = 2000) {
    if (saveTimer) return;
    saveTimer = setInterval(save, intervalMs);
    if (saveTimer.unref) saveTimer.unref();
  }

  function stopAutoSave() {
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
    save(); // Final save
  }

  const db = {
    prepare(sql) {
      // Convert named params (@key) to positional (?) for sql.js
      // better-sqlite3 uses @key and binds from an object.
      // sql.js uses positional ? or $key / :key / @key.
      // We'll convert @key → $key for sql.js compatibility, and map object params.
      const namedKeys = [];
      const sqlJsSql = sql.replace(/@(\w+)/g, (match, key) => {
        namedKeys.push(key);
        return `$${key}`;
      });

      function resolveParams(args) {
        if (args.length === 0) return undefined;
        // If first arg is an object (named params from better-sqlite3 style)
        if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          const obj = args[0];
          // sql.js expects $key prefixed object
          const mapped = {};
          for (const [k, v] of Object.entries(obj)) {
            mapped[`$${k}`] = v === undefined ? null : v;
          }
          return mapped;
        }
        // Positional params — sql.js accepts arrays
        return args.map(v => v === undefined ? null : v);
      }

      return {
        run(...args) {
          const p = resolveParams(args);
          rawDb.run(sqlJsSql, p);
          isDirty = true;
        },
        get(...args) {
          const p = resolveParams(args);
          const stmt = rawDb.prepare(sqlJsSql);
          if (p) stmt.bind(p);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(...args) {
          const pa = resolveParams(args);
          const results = [];
          const stmt = rawDb.prepare(sqlJsSql);
          if (pa) stmt.bind(pa);
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        },
      };
    },

    exec(sql) {
      rawDb.exec(sql);
      isDirty = true;
    },

    pragma(str) {
      try { rawDb.exec(`PRAGMA ${str}`); } catch {}
    },

    transaction(fn) {
      // Emulate better-sqlite3's transaction() — wraps fn in BEGIN/COMMIT
      return function (...args) {
        rawDb.exec("BEGIN");
        try {
          const result = fn(...args);
          rawDb.exec("COMMIT");
          isDirty = true;
          return result;
        } catch (err) {
          rawDb.exec("ROLLBACK");
          throw err;
        }
      };
    },

    save,
    startAutoSave,
    stopAutoSave,
    close() {
      stopAutoSave();
      rawDb.close();
    },

    get filePath() { return filePath; },
  };

  return db;
}

// Schema initialization — same tables as before
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS error_groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    error_class TEXT NOT NULL,
    message_template TEXT NOT NULL,
    trigger_function TEXT NOT NULL,
    trigger_file TEXT NOT NULL,
    trigger_line INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    occurrence_count INTEGER DEFAULT 1,
    status TEXT DEFAULT 'open',
    resolved_by_commit TEXT,
    UNIQUE(project_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS idx_error_groups_project ON error_groups(project_id);
  CREATE INDEX IF NOT EXISTS idx_error_groups_status ON error_groups(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_error_groups_last_seen ON error_groups(project_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_error_groups_function ON error_groups(trigger_function, trigger_file);
  CREATE INDEX IF NOT EXISTS idx_error_groups_fingerprint ON error_groups(project_id, fingerprint);

  CREATE TABLE IF NOT EXISTS error_occurrences (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES error_groups(id),
    trace_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    causal_chain JSON NOT NULL,
    args_shape_at_failure JSON NOT NULL,
    environment JSON NOT NULL,
    preceding_success_count INTEGER,
    preceding_success_shapes JSON
  );

  CREATE INDEX IF NOT EXISTS idx_occurrences_group ON error_occurrences(group_id);
  CREATE INDEX IF NOT EXISTS idx_occurrences_trace ON error_occurrences(trace_id);
  CREATE INDEX IF NOT EXISTS idx_occurrences_timestamp ON error_occurrences(group_id, timestamp);

  CREATE TABLE IF NOT EXISTS error_frequency (
    group_id TEXT NOT NULL REFERENCES error_groups(id),
    bucket TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (group_id, bucket)
  );

  CREATE INDEX IF NOT EXISTS idx_frequency_bucket ON error_frequency(bucket);

  CREATE TABLE IF NOT EXISTS spans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    parent_span_id TEXT,
    node_id TEXT NOT NULL,
    function_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    kind TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_ms REAL,
    status TEXT,
    error_id TEXT,
    args_shape JSON,
    response_shape JSON
  );

  CREATE INDEX IF NOT EXISTS idx_spans_project ON spans(project_id);
  CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
  CREATE INDEX IF NOT EXISTS idx_spans_node ON spans(project_id, node_id);
  CREATE INDEX IF NOT EXISTS idx_spans_start ON spans(project_id, start_time);
  CREATE INDEX IF NOT EXISTS idx_spans_error ON spans(error_id);

  CREATE TABLE IF NOT EXISTS function_stats (
    project_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    function_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER,
    invocation_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    total_duration_ms REAL DEFAULT 0,
    min_duration_ms REAL,
    max_duration_ms REAL,
    p50_duration_ms REAL,
    p95_duration_ms REAL,
    p99_duration_ms REAL,
    last_invoked_at TEXT,
    callers JSON DEFAULT '[]',
    callees JSON DEFAULT '[]',
    arg_shape_success JSON,
    arg_shape_failure JSON,
    PRIMARY KEY (project_id, node_id)
  );

  CREATE INDEX IF NOT EXISTS idx_function_stats_file ON function_stats(project_id, file_path);
  CREATE INDEX IF NOT EXISTS idx_function_stats_errors ON function_stats(project_id, error_count);

  CREATE TABLE IF NOT EXISTS behavioral_baselines (
    project_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    window TEXT NOT NULL,
    invocations_per_hour_p50 REAL,
    invocations_per_hour_p95 REAL,
    duration_p50_ms REAL,
    duration_p95_ms REAL,
    duration_p99_ms REAL,
    error_rate REAL,
    arg_shape_distribution JSON,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (project_id, node_id, window)
  );
`;

/**
 * Create a database with schema initialized. ASYNC.
 */
async function createDatabaseWithSchema(dbPath) {
  const db = await createDatabase(dbPath);
  db.exec(SCHEMA);
  db.save();
  return db;
}

module.exports = {
  createDatabase,
  createDatabaseWithSchema,
  openDatabaseSync,
  ensureInit,
  SCHEMA,
};
