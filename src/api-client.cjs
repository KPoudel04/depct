"use strict";

/**
 * API Client for depct CLI
 *
 * Queries local SQLite database directly.
 * Reads config from ~/.depctrc, .depctrc (project-level), or env vars.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── Config resolution ──

function loadConfig(overrides = {}) {
  const config = {
    projectId: null,
    local: true, // Always local — no remote server in v2 launch
    dbPath: null,
  };

  // 1. Global ~/.depctrc
  const globalRc = path.join(os.homedir(), ".depctrc");
  mergeRcFile(config, globalRc);

  // 2. Project-level .depctrc (walk up from cwd)
  const projectRc = findProjectRc(process.cwd());
  if (projectRc) {
    mergeRcFile(config, projectRc);
  }

  // 3. Environment variables
  if (process.env.DEPCT_PROJECT_ID) config.projectId = process.env.DEPCT_PROJECT_ID;

  // 4. CLI flag overrides
  if (overrides.project) config.projectId = overrides.project;

  // Resolve local DB path
  config.dbPath =
    overrides.dbPath ||
    process.env.DEPCT_DB_PATH ||
    findLocalDb(process.cwd());

  return config;
}

function mergeRcFile(config, filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed.serverUrl) config.serverUrl = parsed.serverUrl;
    if (parsed.apiKey) config.apiKey = parsed.apiKey;
    if (parsed.projectId || parsed.project_id) config.projectId = parsed.projectId || parsed.project_id;
    if (parsed.local) config.local = parsed.local;
  } catch {
    // Silently ignore malformed rc files
  }
}

function findProjectRc(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, ".depctrc");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findLocalDb(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, ".depct", "depct.db");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default path even if it doesn't exist yet
  return path.join(startDir, ".depct", "depct.db");
}

// (HTTP client removed — local-only for v2 launch)

// ── JSON helpers: handle double-encoded shapes from loader ──

/**
 * The loader stores shapes via JSON.stringify(serializeShape(args)) where
 * serializeShape already returns a JSON string. This creates double-encoded
 * values like '"[{\\"id\\":\\"string\\"}]"'. This function peels all layers
 * until we get a proper object/array.
 */
function deepParseJson(val) {
  if (val == null) return null;
  let parsed = val;
  // Peel up to 3 layers of JSON encoding
  for (let i = 0; i < 3; i++) {
    if (typeof parsed !== "string") break;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

/**
 * Clean a shape for AI consumption:
 * - Unwrap single-element arrays: ["string"] → "string", [{...}] → {...}
 * - Remove __type: "IncomingMessage" / "ServerResponse" noise
 * - Ensure proper objects throughout, never stringified junk
 */
function cleanShape(shape) {
  if (shape == null) return null;
  // Unwrap single-element array to its contents
  if (Array.isArray(shape) && shape.length === 1) return cleanShape(shape[0]);
  // Filter out HTTP noise from arrays
  if (Array.isArray(shape)) {
    const filtered = shape.filter((item) => {
      if (item && typeof item === "object" && item.__type) {
        return item.__type !== "IncomingMessage" && item.__type !== "ServerResponse";
      }
      return true;
    }).map(cleanShape);
    return filtered.length === 1 ? filtered[0] : filtered;
  }
  // Clean objects recursively
  if (typeof shape === "object" && shape !== null) {
    if (shape.__type === "IncomingMessage" || shape.__type === "ServerResponse") return null;
    const out = {};
    for (const [k, v] of Object.entries(shape)) {
      if (k === "__type") continue;
      out[k] = typeof v === "object" ? cleanShape(v) : v;
    }
    return out;
  }
  return shape;
}

/**
 * Compute a human/AI-readable diff summary between failure and success shapes.
 * This tells the AI exactly what's different so it can write targeted tests.
 */
function computeShapeDiff(failShape, succShape, errorClass, messageTemplate) {
  if (!failShape && !succShape) {
    return { status: "no_shapes", summary: "No argument shape data available for this error." };
  }
  if (!succShape) {
    return {
      status: "no_success_baseline",
      summary: "No successful calls observed for this function. Cannot diff failure vs success shapes.",
      failure_shape: failShape,
    };
  }

  const failStr = JSON.stringify(failShape);
  const succStr = JSON.stringify(succShape);

  if (failStr === succStr) {
    // Shapes identical — extract insight from error message
    let hint = "Error is likely caused by runtime state, external service behavior, or data not visible in argument shapes.";
    const msg = (messageTemplate || "").toLowerCase();
    if (msg.includes("timeout")) hint = "External service timeout. Args are identical to success cases — the error is non-deterministic (network/service issue). Consider timeout handling or circuit breaker.";
    else if (msg.includes("insufficient funds") || msg.includes("declined")) hint = "Payment declined by external service. Args shape matches success cases — failure depends on account balance/card state, not code.";
    else if (msg.includes("race condition")) hint = "Race condition: concurrent requests with identical shapes produce different outcomes. Consider locking or optimistic concurrency.";
    return {
      status: "identical",
      summary: hint,
      note: "Failure and success argument shapes are identical. The bug is not in the data shape — it is in external state or timing.",
    };
  }

  // Find specific field differences
  const diffs = [];
  if (typeof failShape === "object" && typeof succShape === "object" && !Array.isArray(failShape) && !Array.isArray(succShape)) {
    for (const key of new Set([...Object.keys(failShape), ...Object.keys(succShape)])) {
      const fVal = failShape[key];
      const sVal = succShape[key];
      if (JSON.stringify(fVal) !== JSON.stringify(sVal)) {
        diffs.push({ field: key, on_failure: fVal, on_success: sVal });
      }
    }
  }

  return {
    status: "differs",
    summary: diffs.length > 0
      ? `${diffs.length} field(s) differ: ${diffs.map((d) => d.field).join(", ")}`
      : "Shapes differ structurally (different types or array lengths).",
    field_diffs: diffs.length > 0 ? diffs : undefined,
    failure_shape: failShape,
    success_shape: succShape,
  };
}

/**
 * Parse an array where each element may itself be a JSON string.
 * E.g. the loader stores preceding_success_shapes as
 * JSON.stringify([JSON.stringify(shape1), JSON.stringify(shape2)])
 */
function deepParseJsonArray(val) {
  const arr = deepParseJson(val);
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => deepParseJson(item));
}

/**
 * Parse a causal chain and enrich its entries with any available span data
 * from the same trace.
 */
function safeParseCausalChain(raw) {
  const chain = deepParseJson(raw);
  if (!Array.isArray(chain)) return [];
  return chain;
}

// ── Local mode: direct SQLite access ──

let _localDb = null;

async function getLocalDb(config) {
  if (_localDb) return _localDb;

  if (!config.dbPath || !fs.existsSync(config.dbPath)) {
    throw new Error(
      `Local database not found at ${config.dbPath || ".depct/depct.db"}. ` +
        `Run 'depct start -- node server.js' first to capture data.`
    );
  }

  const { ensureInit, openDatabaseSync } = require("../shared/db.cjs");
  await ensureInit();

  const db = openDatabaseSync(config.dbPath, { fileMustExist: true });
  _localDb = { path: config.dbPath, db };
  return _localDb;
}

// ── API Client class ──

class ApiClient {
  constructor(overrides = {}) {
    this.config = loadConfig(overrides);
  }

  async get(endpoint, params = {}) {
    return this._query("GET", endpoint, params);
  }

  async post(endpoint, body = {}) {
    return this._query("POST", endpoint, body);
  }

  async ping() {
    try {
      const local = await getLocalDb(this.config);
      return { ok: true, mode: "local", dbPath: local.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── SQLite queries ──

  async _query(method, endpoint, params) {
    const local = await getLocalDb(this.config);
    const db = local.db;
    const projectId = this.config.projectId;

    // GET /v2/errors — list error groups
    if (endpoint === "/v2/errors" || endpoint === "/api/errors" || endpoint === "/api/error-groups") {
      let sql = `SELECT * FROM error_groups WHERE project_id = ?`;
      const sqlArgs = [projectId];

      if (params.status) {
        sql += ` AND status = ?`;
        sqlArgs.push(params.status);
      }
      if (params.function) {
        sql += ` AND trigger_function = ?`;
        sqlArgs.push(params.function);
      }
      if (params.since) {
        sql += ` AND last_seen_at >= ?`;
        sqlArgs.push(params.since);
      }
      sql += ` ORDER BY last_seen_at DESC LIMIT ?`;
      sqlArgs.push(params.limit || 50);

      const groups = db.prepare(sql).all(...sqlArgs);

      // Frequency queries — match the hourly bucket format used by the loader
      const freqStmt = db.prepare(
        `SELECT SUM(count) as total FROM error_frequency WHERE group_id = ? AND bucket >= ?`
      );
      const now = new Date();
      const h1  = new Date(now - 1 * 60 * 60 * 1000).toISOString().slice(0, 13);
      const h24 = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 13);
      const d7  = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13);

      // Blast radius: find actual route handlers (not the generic handleRequest dispatcher)
      const endpointStmt = db.prepare(`
        SELECT DISTINCT s.node_id, s.function_name FROM spans s
        INNER JOIN error_occurrences eo ON eo.trace_id = s.trace_id
        WHERE eo.group_id = ? AND s.file_path LIKE '%routes%'
          AND s.function_name NOT IN ('handleRequest')
        LIMIT 20
      `);

      // Count affected traces and total traces for impact %
      const traceCountStmt = db.prepare(
        `SELECT COUNT(DISTINCT trace_id) as cnt FROM error_occurrences WHERE group_id = ?`
      );
      const totalTraces = db.prepare(
        `SELECT COUNT(DISTINCT trace_id) as cnt FROM spans WHERE project_id = ?`
      ).get(projectId);
      const totalTraceCount = (totalTraces || {}).cnt || 1;

      const enriched = groups.map((g) => {
        const lastHour = (freqStmt.get(g.id, h1) || {}).total || 0;
        const last24h  = (freqStmt.get(g.id, h24) || {}).total || 0;
        const last7d   = (freqStmt.get(g.id, d7) || {}).total || 0;

        // Trend
        const ageHours = (now - new Date(g.first_seen_at)) / 3600000;
        let trend = "stable";
        if (g.status === "resolved" && last24h > 0) trend = "regressing";
        else if (ageHours < 24) trend = "new";
        else {
          const dailyAvg = last7d / 7;
          const velocity = dailyAvg > 0 ? last24h / dailyAvg : last24h > 0 ? 10 : 0;
          if (velocity > 3) trend = "spiking";
          else if (velocity < 0.5) trend = "declining";
        }

        // Severity
        let severity = "low";
        if (trend === "regressing" || trend === "spiking") severity = "critical";
        else if (trend === "new" && last24h >= 5) severity = "high";
        else if (trend === "new") severity = "medium";
        else if (last24h >= 20) severity = "high";
        else if (last24h >= 5) severity = "medium";

        // Latest occurrence
        const occ = db.prepare(
          `SELECT causal_chain, args_shape_at_failure, preceding_success_shapes, preceding_success_count
           FROM error_occurrences WHERE group_id = ? ORDER BY timestamp DESC LIMIT 1`
        ).get(g.id);

        // Parse and clean shapes
        const rawFailShape = occ ? deepParseJson(occ.args_shape_at_failure) : null;
        const rawSuccShapes = occ && occ.preceding_success_shapes ? deepParseJsonArray(occ.preceding_success_shapes) : [];
        const rawSuccShape = rawSuccShapes.length > 0 ? rawSuccShapes[0] : null;

        const failShape = cleanShape(rawFailShape);
        const succShape = cleanShape(rawSuccShape);

        // Compute shape diff summary for AI
        const shapeDiff = computeShapeDiff(failShape, succShape, g.error_class, g.message_template);

        // Blast radius: real route handlers + impact estimate
        let affectedEndpoints = [];
        try {
          affectedEndpoints = endpointStmt.all(g.id).map((r) => r.function_name || r.node_id);
        } catch { /* */ }
        if (affectedEndpoints.length === 0) {
          // Fall back: extract from causal chain (first route-level entry)
          const chain = occ ? safeParseCausalChain(occ.causal_chain) : [];
          for (const step of chain) {
            if (step.node_id && step.node_id.includes('/routes/') && !step.node_id.includes('handleRequest')) {
              const parts = step.node_id.split(':');
              affectedEndpoints.push(parts[1] || step.node_id);
              break;
            }
          }
        }
        const traceCount = (traceCountStmt.get(g.id) || {}).cnt || 0;
        const impactPct = totalTraceCount > 0 ? Math.round((traceCount / totalTraceCount) * 100) : 0;

        // Clean causal chain: remove noisy IncomingMessage shapes
        const chain = occ ? safeParseCausalChain(occ.causal_chain) : [];
        const cleanedChain = chain.map((step) => ({
          node_id: step.node_id,
          args_shape: cleanShape(deepParseJson(step.args_shape)),
        }));

        return {
          group_id: g.id,
          severity,
          error_class: g.error_class,
          message_template: g.message_template,
          trigger: {
            function: g.trigger_function,
            file: g.trigger_file,
            line: g.trigger_line,
          },
          frequency: {
            total: g.occurrence_count,
            last_hour: lastHour,
            last_day: last24h,
            last_week: last7d,
          },
          trend,
          status: g.status,
          first_seen: g.first_seen_at,
          last_seen: g.last_seen_at,
          causal_chain: cleanedChain,
          args_shape_at_failure: failShape,
          args_shape_when_succeeds: succShape,
          shape_diff: shapeDiff,
          preceding_successes: occ ? (occ.preceding_success_count || 0) : 0,
          blast_radius: {
            affected_endpoints: affectedEndpoints,
            affected_traces: traceCount,
            impact_pct: impactPct,
          },
        };
      });

      const summary = {
        total_groups: enriched.length,
        by_severity: {
          critical: enriched.filter((e) => e.severity === "critical").length,
          high: enriched.filter((e) => e.severity === "high").length,
          medium: enriched.filter((e) => e.severity === "medium").length,
          low: enriched.filter((e) => e.severity === "low").length,
        },
        total_occurrences: enriched.reduce((s, e) => s + (e.frequency.total || 0), 0),
        trending_up: enriched.filter((e) => e.trend === "spiking" || e.trend === "new" || e.trend === "regressing").length,
      };

      return { command: "errors", project: projectId, error_groups: enriched, summary };
    }

    // GET /v2/errors/:id — single error group detail
    if (/^\/(?:v2|api)\/errors\/[^/]+$/.test(endpoint)) {
      const groupId = endpoint.split("/").pop();
      const group = db.prepare(`SELECT * FROM error_groups WHERE id = ?`).get(groupId);
      if (!group) return { error: "not_found" };

      const occurrences = db.prepare(
        `SELECT * FROM error_occurrences WHERE group_id = ? ORDER BY timestamp DESC LIMIT 20`
      ).all(groupId);

      return {
        ...group,
        occurrences: occurrences.map((o) => ({
          ...o,
          causal_chain: safeParseCausalChain(o.causal_chain),
          args_shape_at_failure: deepParseJson(o.args_shape_at_failure),
          environment: deepParseJson(o.environment),
          preceding_success_shapes: o.preceding_success_shapes ? deepParseJson(o.preceding_success_shapes) : [],
        })),
      };
    }

    // GET /api/inspect — function deep dive
    if (endpoint === "/api/inspect" || endpoint === "/v2/inspect") {
      const fn = params.function || params.fn;

      // Get ALL matching function_stats rows (may span multiple files)
      const allStats = db.prepare(
        `SELECT * FROM function_stats WHERE project_id = ? AND (function_name = ? OR node_id LIKE ?)`
      ).all(projectId, fn, `%:${fn}:%`);

      // Prefer the one with errors, or highest invocation count
      const stats = allStats.length > 1
        ? allStats.sort((a, b) => (b.error_count || 0) - (a.error_count || 0))[0]
        : allStats[0];

      // Only get errors from the same file as the selected stats row
      const triggerFile = stats?.file_path;
      const errors = triggerFile
        ? db.prepare(
            `SELECT * FROM error_groups WHERE project_id = ? AND trigger_function = ? AND trigger_file = ? ORDER BY last_seen_at DESC`
          ).all(projectId, fn, triggerFile)
        : db.prepare(
            `SELECT * FROM error_groups WHERE project_id = ? AND trigger_function = ? ORDER BY last_seen_at DESC`
          ).all(projectId, fn);

      const s = stats || {};
      const invocations = s.invocation_count || 0;
      const errorCount = s.error_count || 0;
      const errorRate = invocations > 0 ? errorCount / invocations : 0;

      // Extract line from node_id if line column is null: "file:fn:65" → 65
      let line = s.line || null;
      if (!line && s.node_id) {
        const parts = s.node_id.split(":");
        const lastPart = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastPart)) line = lastPart;
      }

      // Compute latency from spans if function_stats doesn't have it
      let p50 = s.p50_duration_ms || 0;
      let p95 = s.p95_duration_ms || 0;
      let p99 = s.p99_duration_ms || 0;
      if (p50 === 0 && s.node_id) {
        const durations = db.prepare(
          `SELECT duration_ms FROM spans WHERE project_id = ? AND node_id = ? AND duration_ms > 0 ORDER BY duration_ms ASC`
        ).all(projectId, s.node_id).map((r) => r.duration_ms);
        if (durations.length > 0) {
          p50 = durations[Math.floor(durations.length * 0.5)] || 0;
          p95 = durations[Math.floor(durations.length * 0.95)] || 0;
          p99 = durations[Math.floor(durations.length * 0.99)] || 0;
        }
      }

      // Note if there are other functions with the same name in different files
      const otherFiles = allStats.length > 1
        ? allStats.filter((r) => r.file_path !== triggerFile).map((r) => r.file_path)
        : undefined;

      return {
        function: fn,
        file: s.file_path || null,
        line,
        found: !!stats,
        other_files: otherFiles,
        call_profile: {
          invocations,
          error_rate: errorRate,
          p50_ms: p50,
          p95_ms: p95,
          p99_ms: p99,
        },
        callers: s.callers ? deepParseJson(s.callers) : [],
        callees: s.callees ? deepParseJson(s.callees) : [],
        errors: errors.map((e) => ({
          group_id: e.id,
          error_class: e.error_class,
          message: e.message_template,
          count: e.occurrence_count,
        })),
        arg_shapes: {
          success: s.arg_shape_success ? deepParseJson(s.arg_shape_success) : null,
          failure: s.arg_shape_failure ? deepParseJson(s.arg_shape_failure) : null,
        },
        last_invoked: s.last_invoked_at || null,
      };
    }

    // GET /api/status
    if (endpoint === "/api/status" || endpoint === "/v2/status") {
      const errCount = db.prepare(`SELECT COUNT(*) as c FROM error_groups WHERE project_id = ?`).get(projectId);
      const traceCount = db.prepare(`SELECT COUNT(DISTINCT trace_id) as c FROM spans WHERE project_id = ?`).get(projectId);
      const funcCount = db.prepare(`SELECT COUNT(*) as c FROM function_stats WHERE project_id = ?`).get(projectId);
      const lastSpan = db.prepare(`SELECT start_time FROM spans WHERE project_id = ? ORDER BY start_time DESC LIMIT 1`).get(projectId);

      // Return in the shape that status.cjs normalizer expects
      return {
        project_id: projectId,
        name: projectId,
        functions_tracked: (funcCount || {}).c || 0,
        error_groups: (errCount || {}).c || 0,
        traces_today: (traceCount || {}).c || 0,
        last_event: lastSpan ? lastSpan.start_time : null,
      };
    }

    // GET /api/build-test — test candidates
    if (endpoint === "/api/build-test" || endpoint === "/v2/test-candidates") {
      const maxCandidates = params.limit ? parseInt(params.limit, 10) : 10;

      const groups = db.prepare(
        `SELECT * FROM error_groups WHERE project_id = ? AND status = 'open' ORDER BY occurrence_count DESC`
      ).all(projectId);

      const now = new Date();
      const btFreqStmt = db.prepare(
        `SELECT SUM(count) as total FROM error_frequency WHERE group_id = ? AND bucket >= ?`
      );
      const h24Bucket = new Date(now.getTime() - 24 * 3600000).toISOString().slice(0, 13);
      const d7Bucket = new Date(now.getTime() - 7 * 24 * 3600000).toISOString().slice(0, 13);

      // Group similar errors: same normalized message pattern → one candidate
      // e.g., all "Payment gateway timeout" become one entry
      const grouped = new Map(); // key → { primary: group, related: [groups], totalOccurrences }
      for (const g of groups) {
        // Key by: error_class + first 40 chars of normalized message + trigger_function
        const msgKey = g.message_template.replace(/\{[^}]+\}/g, "*").substring(0, 40);
        const key = `${g.error_class}:${msgKey}:${g.trigger_function}`;
        if (!grouped.has(key)) {
          grouped.set(key, { primary: g, related: [], totalOccurrences: g.occurrence_count });
        } else {
          const entry = grouped.get(key);
          entry.related.push(g);
          entry.totalOccurrences += g.occurrence_count;
        }
      }

      const candidates = [];
      for (const [, { primary: g, related, totalOccurrences }] of grouped) {
        const last24h = (btFreqStmt.get(g.id, h24Bucket) || {}).total || 0;
        const last7d = (btFreqStmt.get(g.id, d7Bucket) || {}).total || 0;

        const occ = db.prepare(
          `SELECT causal_chain, args_shape_at_failure, preceding_success_shapes, preceding_success_count
           FROM error_occurrences WHERE group_id = ? ORDER BY timestamp DESC LIMIT 1`
        ).get(g.id);

        const rawFailShape = occ ? deepParseJson(occ.args_shape_at_failure) : null;
        const rawSuccShapes = occ && occ.preceding_success_shapes ? deepParseJsonArray(occ.preceding_success_shapes) : [];
        const chain = occ ? safeParseCausalChain(occ.causal_chain) : [];

        const failShape = cleanShape(rawFailShape);
        const succShape = cleanShape(rawSuccShapes[0] || null);
        const shapeDiff = computeShapeDiff(failShape, succShape, g.error_class, g.message_template);

        // Scoring: prioritize candidates where the AI can actually write a useful test
        const ageHours = (now - new Date(g.first_seen_at)) / 3600000;
        const isNew = ageHours < 24;
        const dailyAvg = last7d / 7;
        const velocity = dailyAvg > 0 ? last24h / dailyAvg : last24h > 0 ? 5 : 0;

        // Shape diff is the most important signal — if shapes differ, AI can write a targeted test
        let shapeDiffScore = 0;
        if (shapeDiff.status === "differs") shapeDiffScore = 35;
        else if (shapeDiff.status === "no_success_baseline") shapeDiffScore = 15;
        else if (shapeDiff.status === "identical") shapeDiffScore = 5; // low — shapes identical, hard to test
        // Frequency (0-25)
        const freqScore = Math.min(25, Math.round(Math.log2(Math.max(totalOccurrences, 1)) * 5));
        // Trend (0-20)
        let trendScore = 10;
        if (isNew) trendScore = 15;
        if (velocity > 3) trendScore = 20;
        else if (velocity < 0.5) trendScore = 5;
        // Chain depth (0-20)
        const chainScore = Math.min(20, chain.length * 5);

        const score = shapeDiffScore + freqScore + trendScore + chainScore;
        let value = "low";
        if (score >= 65) value = "critical";
        else if (score >= 45) value = "high";
        else if (score >= 25) value = "medium";

        // Clean the chain for output
        const cleanedChain = chain.map((step) => ({
          node_id: step.node_id,
          args_shape: cleanShape(deepParseJson(step.args_shape)),
        }));

        candidates.push({
          candidate_id: g.id.replace("eg_", "tc_"),
          value,
          score,
          score_breakdown: { shape_diff: shapeDiffScore, frequency: freqScore, trend: trendScore, chain_depth: chainScore },
          error: {
            group_id: g.id,
            class: g.error_class,
            message: g.message_template,
            function: g.trigger_function,
            file: g.trigger_file,
            line: g.trigger_line,
          },
          grouped_count: related.length > 0 ? related.length + 1 : undefined,
          grouped_note: related.length > 0
            ? `${related.length} similar error group(s) with same pattern in ${g.trigger_function}. Total: ${totalOccurrences} occurrences.`
            : undefined,
          reproduction: {
            call_path: cleanedChain,
            args_at_failure: failShape,
            args_at_success: succShape,
            shape_diff: shapeDiff,
            preceding_successes: occ ? (occ.preceding_success_count || 0) : 0,
          },
          frequency: {
            total: totalOccurrences,
            last_24h: last24h,
            last_7d: last7d,
            trend: velocity > 3 ? "spiking" : velocity < 0.5 ? "declining" : isNew ? "new" : "stable",
          },
        });
      }

      // Sort by score descending, limit to top N
      const sorted = candidates.sort((a, b) => b.score - a.score).slice(0, maxCandidates);

      return {
        command: "build-test",
        project: projectId,
        candidates: sorted,
        summary: {
          total_error_groups: groups.length,
          grouped_into: grouped.size,
          candidates_returned: sorted.length,
          by_value: {
            critical: sorted.filter((c) => c.value === "critical").length,
            high: sorted.filter((c) => c.value === "high").length,
            medium: sorted.filter((c) => c.value === "medium").length,
            low: sorted.filter((c) => c.value === "low").length,
          },
        },
      };
    }

    // GET /api/traces — list traces for an endpoint, or single trace by ID
    if (endpoint === "/api/traces" || endpoint === "/v2/traces") {
      const endpointFilter = params.endpoint;
      const limit = params.limit || 10;
      const errorsOnly = params.errors_only;
      const sort = params.sort;

      // Traces are identified by distinct trace_ids. The root span (parent_span_id IS NULL
      // or empty) represents the entry point. HTTP-plugin spans (node_id LIKE 'http:%') are
      // separate trace_ids — the function-level spans live under handleRequest or the
      // route handler as root.
      //
      // Strategy: find distinct traces that have spans matching the endpoint filter.
      // The endpoint might match a route file path, function name, or http:* node_id.

      let traceSql = `
        SELECT s.trace_id,
               MAX(s.duration_ms) as max_ms,
               MIN(s.start_time) as first_start,
               COUNT(*) as span_count,
               SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END) as error_count
        FROM spans s
        WHERE s.project_id = ?
          AND s.node_id NOT LIKE 'http:%'
      `;
      const traceArgs = [projectId];

      if (endpointFilter) {
        // Match against node_id, function_name, or file_path (excluding http:* spans
        // which live on separate trace_ids with no function-level children)
        traceSql += ` AND s.trace_id IN (
          SELECT DISTINCT trace_id FROM spans
          WHERE project_id = ? AND node_id NOT LIKE 'http:%' AND (
            node_id LIKE ? OR function_name LIKE ? OR file_path LIKE ?
          )
        )`;
        const pattern = `%${endpointFilter.replace(/^\//, "")}%`;
        traceArgs.push(projectId, pattern, pattern, pattern);
      }

      traceSql += ` GROUP BY s.trace_id`;

      if (errorsOnly) {
        traceSql += ` HAVING error_count > 0`;
      }
      if (sort === "duration_desc") {
        traceSql += ` ORDER BY max_ms DESC`;
      } else {
        traceSql += ` ORDER BY first_start DESC`;
      }
      traceSql += ` LIMIT ?`;
      traceArgs.push(limit);

      const traceRows = db.prepare(traceSql).all(...traceArgs);

      const spansByTrace = db.prepare(
        `SELECT id, trace_id, node_id, function_name, file_path, duration_ms, status,
                parent_span_id, error_id, start_time, args_shape
         FROM spans WHERE trace_id = ? AND node_id NOT LIKE 'http:%' ORDER BY start_time ASC`
      );

      const traces = traceRows.map((t) => buildTraceResult(t.trace_id, spansByTrace.all(t.trace_id)));

      return { traces };
    }

    // GET /api/traces/:id — single trace by ID
    if (/^\/(?:v2|api)\/traces\/[^/]+$/.test(endpoint)) {
      const traceId = endpoint.split("/").pop();
      const allSpans = db.prepare(
        `SELECT id, trace_id, node_id, function_name, file_path, duration_ms, status,
                parent_span_id, error_id, start_time, args_shape
         FROM spans WHERE trace_id = ? AND node_id NOT LIKE 'http:%' ORDER BY start_time ASC`
      ).all(traceId);

      if (allSpans.length === 0) return { error: "not_found" };
      return buildTraceResult(traceId, allSpans);
    }

    // GET /api/deps — external dependencies (http outbound, db, cache)
    if (endpoint === "/api/deps" || endpoint === "/v2/deps") {
      const limit = params.limit || 50;
      const typeFilter = params.type || null;

      // External calls come from http-outbound plugin (kind = 'http-outbound',
      // node_id like 'http:outbound:METHOD:hostname') and db-patch plugin (kind = 'db').
      // We also catch any node_id pattern that looks like an outbound call.
      let sql = `
        SELECT node_id, kind, function_name, duration_ms, status, start_time
        FROM spans
        WHERE project_id = ?
          AND (
            kind IN ('http-outbound', 'db', 'cache')
            OR node_id LIKE 'http:outbound:%'
          )
      `;
      const sqlArgs = [projectId];

      if (params.since) {
        sql += ` AND start_time >= ?`;
        sqlArgs.push(params.since);
      }

      sql += ` ORDER BY start_time DESC`;

      const rows = db.prepare(sql).all(...sqlArgs);

      if (rows.length === 0) {
        // No external dependency spans found — return empty with helpful note
        return {
          command: "deps",
          project: projectId,
          dependencies: [],
          summary: { total: 0, healthy: 0, degraded: 0, critical: 0 },
          note: "No external dependency spans found. The http-outbound and db-patch plugins create these spans when your app makes outbound HTTP calls or database queries. If your app makes external calls, ensure these plugins are enabled in your depct configuration.",
        };
      }

      // Group spans by service name
      const groups = new Map();
      for (const row of rows) {
        let name, type, method;

        if (row.kind === "db" || row.node_id.startsWith("db:")) {
          // Database span: node_id might be 'db:postgres:query' or similar
          const parts = row.node_id.split(":");
          name = parts[1] || row.function_name || "database";
          type = "database";
          method = parts[2] || "query";
        } else if (row.kind === "cache" || row.node_id.startsWith("cache:")) {
          const parts = row.node_id.split(":");
          name = parts[1] || "cache";
          type = "cache";
          method = parts[2] || "get";
        } else {
          // HTTP outbound: node_id like 'http:outbound:GET:api.stripe.com'
          const parts = row.node_id.split(":");
          method = parts[2] || "GET";
          name = parts[3] || row.function_name || "unknown-host";
          type = "http";
        }

        if (typeFilter && type !== typeFilter) continue;

        if (!groups.has(name)) {
          groups.set(name, {
            name,
            type,
            methods: new Set(),
            durations: [],
            errors: 0,
            total: 0,
            last_seen: null,
          });
        }

        const g = groups.get(name);
        g.methods.add(method);
        g.durations.push(row.duration_ms || 0);
        g.total++;
        if (row.status === "error") g.errors++;
        if (!g.last_seen || row.start_time > g.last_seen) {
          g.last_seen = row.start_time;
        }
      }

      // Compute stats for each group
      const dependencies = [];
      for (const [, g] of groups) {
        const sorted = g.durations.slice().sort((a, b) => a - b);
        const p95Idx = Math.floor(sorted.length * 0.95);
        const p95 = sorted[Math.min(p95Idx, sorted.length - 1)] || 0;
        const avg = sorted.length > 0
          ? sorted.reduce((s, v) => s + v, 0) / sorted.length
          : 0;
        const errorRate = g.total > 0 ? (g.errors / g.total) * 100 : 0;

        let health = "healthy";
        if (errorRate > 10 || p95 > 5000) health = "critical";
        else if (errorRate > 2 || p95 > 2000) health = "degraded";

        dependencies.push({
          name: g.name,
          type: g.type,
          health,
          calls_24h: g.total,
          error_rate: Math.round(errorRate * 100) / 100,
          p95_ms: Math.round(p95 * 100) / 100,
          avg_ms: Math.round(avg * 100) / 100,
          last_seen: g.last_seen,
          methods: Array.from(g.methods),
        });
      }

      // Sort: critical first, then degraded, then healthy; within same health by calls desc
      const healthOrder = { critical: 0, degraded: 1, healthy: 2 };
      dependencies.sort((a, b) => {
        const hDiff = (healthOrder[a.health] || 3) - (healthOrder[b.health] || 3);
        if (hDiff !== 0) return hDiff;
        return b.calls_24h - a.calls_24h;
      });

      const limited = dependencies.slice(0, limit);
      const summary = {
        total: limited.length,
        healthy: limited.filter((d) => d.health === "healthy").length,
        degraded: limited.filter((d) => d.health === "degraded").length,
        critical: limited.filter((d) => d.health === "critical").length,
      };

      return { command: "deps", project: projectId, dependencies: limited, summary };
    }

    // GET /api/anomalies — behavioral anomaly detection
    if (endpoint === "/api/anomalies" || endpoint === "/v2/anomalies") {
      const limit = params.limit || 50;
      const severityFilter = params.severity || null;

      // Determine the recent window boundary (default: 1 hour)
      const now = new Date();
      const recentCutoff = params.since
        ? new Date(params.since)
        : new Date(now.getTime() - 60 * 60 * 1000);
      const recentCutoffISO = recentCutoff.toISOString();

      // 1. Get all functions with historical stats
      const allFunctions = db.prepare(
        `SELECT node_id, function_name, file_path, invocation_count, error_count,
                total_duration_ms, p95_duration_ms, last_invoked_at
         FROM function_stats WHERE project_id = ?`
      ).all(projectId);

      // 2. Compute recent behavior from spans
      const recentStatsStmt = db.prepare(
        `SELECT COUNT(*) as cnt,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as err_cnt,
                AVG(duration_ms) as avg_ms,
                MAX(duration_ms) as max_ms
         FROM spans
         WHERE project_id = ? AND node_id = ? AND start_time >= ?`
      );

      const anomalies = [];

      for (const fn of allFunctions) {
        // Skip http:* meta-spans
        if (fn.node_id.startsWith("http:")) continue;

        const recent = recentStatsStmt.get(projectId, fn.node_id, recentCutoffISO);
        const recentCount = recent?.cnt || 0;
        const recentErrors = recent?.err_cnt || 0;
        const recentMaxMs = recent?.max_ms || 0;

        const historicalCount = fn.invocation_count || 0;
        const historicalErrors = fn.error_count || 0;
        const historicalP95 = fn.p95_duration_ms || 0;

        // Baseline error rate (all-time)
        const baselineErrorRate = historicalCount > 0
          ? historicalErrors / historicalCount
          : 0;

        // Recent error rate
        const recentErrorRate = recentCount > 0
          ? recentErrors / recentCount
          : 0;

        // --- Error rate spike ---
        if (recentCount >= 2 && recentErrorRate > 0) {
          if (baselineErrorRate > 0) {
            const ratio = parseFloat((recentErrorRate / baselineErrorRate).toFixed(2));
            if (ratio >= 3) {
              anomalies.push({
                node_id: fn.node_id,
                function: fn.function_name,
                file: fn.file_path,
                type: "error_rate_spike",
                severity: ratio >= 10 ? "critical" : "warning",
                current_value: parseFloat(recentErrorRate.toFixed(4)),
                baseline_value: parseFloat(baselineErrorRate.toFixed(4)),
                ratio,
                description: `Error rate jumped ${ratio}x above baseline (${(recentErrorRate * 100).toFixed(1)}% vs ${(baselineErrorRate * 100).toFixed(1)}% historical).`,
              });
            }
          } else if (recentErrors > 0) {
            // No historical errors but now seeing errors
            anomalies.push({
              node_id: fn.node_id,
              function: fn.function_name,
              file: fn.file_path,
              type: "error_rate_spike",
              severity: "critical",
              current_value: parseFloat(recentErrorRate.toFixed(4)),
              baseline_value: 0,
              ratio: Infinity,
              description: `Function started erroring (${recentErrors}/${recentCount} calls failing) with zero historical errors.`,
            });
          }
        }

        // --- Latency spike ---
        if (recentCount >= 2 && historicalP95 > 0 && recentMaxMs > 0) {
          const ratio = parseFloat((recentMaxMs / historicalP95).toFixed(2));
          if (ratio >= 3) {
            anomalies.push({
              node_id: fn.node_id,
              function: fn.function_name,
              file: fn.file_path,
              type: "latency_spike",
              severity: ratio >= 10 ? "critical" : "warning",
              current_value: parseFloat(recentMaxMs.toFixed(2)),
              baseline_value: parseFloat(historicalP95.toFixed(2)),
              ratio,
              description: `Recent max latency ${recentMaxMs.toFixed(1)}ms is ${ratio}x above historical p95 (${historicalP95.toFixed(1)}ms).`,
            });
          }
        }

        // --- Traffic spike / drop ---
        if (historicalCount >= 5) {
          // Calculate historical rate: total invocations over the age of the function
          const firstSpan = db.prepare(
            `SELECT MIN(start_time) as first FROM spans WHERE project_id = ? AND node_id = ?`
          ).get(projectId, fn.node_id);
          const firstTime = firstSpan?.first ? new Date(firstSpan.first) : null;
          if (firstTime) {
            const totalAgeHours = Math.max(1, (now.getTime() - firstTime.getTime()) / 3600000);
            const recentWindowHours = Math.max(0.01, (now.getTime() - recentCutoff.getTime()) / 3600000);

            const historicalRate = historicalCount / totalAgeHours; // calls per hour
            const recentRate = recentCount / recentWindowHours;

            if (historicalRate > 0) {
              const ratio = parseFloat((recentRate / historicalRate).toFixed(2));

              if (ratio >= 3) {
                anomalies.push({
                  node_id: fn.node_id,
                  function: fn.function_name,
                  file: fn.file_path,
                  type: "traffic_spike",
                  severity: ratio >= 10 ? "warning" : "info",
                  current_value: parseFloat(recentRate.toFixed(2)),
                  baseline_value: parseFloat(historicalRate.toFixed(2)),
                  ratio,
                  description: `Traffic ${ratio}x above normal (${recentRate.toFixed(1)} calls/hr vs ${historicalRate.toFixed(1)} calls/hr baseline).`,
                });
              } else if (ratio <= 0.3 && recentCount > 0) {
                anomalies.push({
                  node_id: fn.node_id,
                  function: fn.function_name,
                  file: fn.file_path,
                  type: "traffic_drop",
                  severity: "warning",
                  current_value: parseFloat(recentRate.toFixed(2)),
                  baseline_value: parseFloat(historicalRate.toFixed(2)),
                  ratio,
                  description: `Traffic dropped to ${(ratio * 100).toFixed(0)}% of normal (${recentRate.toFixed(1)} calls/hr vs ${historicalRate.toFixed(1)} calls/hr baseline).`,
                });
              }
            }
          }
        }

        // --- Gone silent ---
        if (historicalCount >= 3 && recentCount === 0) {
          anomalies.push({
            node_id: fn.node_id,
            function: fn.function_name,
            file: fn.file_path,
            type: "gone_silent",
            severity: historicalCount >= 10 ? "warning" : "info",
            current_value: 0,
            baseline_value: historicalCount,
            ratio: 0,
            description: `Function had ${historicalCount} historical invocations but zero calls in the recent window.`,
          });
        }
      }

      // Sort by severity (critical > warning > info) then by ratio descending
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      anomalies.sort((a, b) => {
        const sevDiff = (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3);
        if (sevDiff !== 0) return sevDiff;
        const aRatio = a.ratio === Infinity ? 999999 : a.ratio;
        const bRatio = b.ratio === Infinity ? 999999 : b.ratio;
        return bRatio - aRatio;
      });

      // Apply severity filter
      const filtered = severityFilter
        ? anomalies.filter((a) => a.severity === severityFilter)
        : anomalies;

      const limited = filtered.slice(0, limit);

      const summary = {
        total: limited.length,
        critical: limited.filter((a) => a.severity === "critical").length,
        warning: limited.filter((a) => a.severity === "warning").length,
        info: limited.filter((a) => a.severity === "info").length,
      };

      return { command: "anomalies", project: projectId, anomalies: limited, summary };
    }

    // Fallback
    throw new Error(`Unknown local endpoint: ${method} ${endpoint}`);
  }
}

/**
 * Build a structured trace result from a flat list of spans.
 * Assembles the parent-child tree, detects endpoint, bottleneck, errors.
 */
function buildTraceResult(traceId, allSpans) {
  if (!allSpans || allSpans.length === 0) return { trace_id: traceId, spans: [] };

  // Build span tree — two passes: create all nodes, then link children
  const spanMap = new Map();
  const rootSpans = [];

  for (const s of allSpans) {
    spanMap.set(s.id, {
      span_id: s.id,
      name: s.function_name,
      file: s.file_path,
      node_id: s.node_id,
      duration_ms: s.duration_ms || 0,
      status: s.status || "ok",
      start_time: s.start_time,
      error: s.status === "error",
      args_shape: s.args_shape ? deepParseJson(s.args_shape) : null,
      children: [],
    });
  }

  for (const s of allSpans) {
    const span = spanMap.get(s.id);
    if (s.parent_span_id && spanMap.has(s.parent_span_id)) {
      spanMap.get(s.parent_span_id).children.push(span);
    } else {
      rootSpans.push(span);
    }
  }

  // Find the root entry point (the span with no parent, typically handleRequest or a route)
  const rootSpan = rootSpans.find((s) => !s.node_id.startsWith("http:")) || rootSpans[0];

  // Detect endpoint: prefer route handler over generic handleRequest
  let endpointName = rootSpan?.name || "unknown";
  const GENERIC_FUNCTIONS = new Set(["handleRequest", "checkRateLimit", "authenticate", "middleware"]);
  const routeSpan = allSpans.find((s) =>
    s.file_path && (s.file_path.includes("/routes/") || s.file_path.includes("/controllers/")) && !GENERIC_FUNCTIONS.has(s.function_name)
  );
  if (routeSpan) {
    endpointName = routeSpan.function_name;
  } else {
    // Fallback: first non-generic function
    const bizSpan = allSpans.find((s) => !GENERIC_FUNCTIONS.has(s.function_name) && s.function_name);
    if (bizSpan) endpointName = bizSpan.function_name;
  }

  // Bottleneck: leaf span with highest duration (exclude the root wrapper)
  let bottleneck = null;
  let maxLeafMs = 0;
  for (const s of allSpans) {
    const node = spanMap.get(s.id);
    if (node && node.children.length === 0 && (s.duration_ms || 0) > maxLeafMs) {
      maxLeafMs = s.duration_ms;
      bottleneck = `${s.function_name} (${s.duration_ms.toFixed(1)}ms)`;
    }
  }

  // Error detection
  const errorSpan = allSpans.find((s) => s.status === "error");
  const errorInfo = errorSpan ? `${errorSpan.function_name} at ${errorSpan.file_path}` : null;
  const hasError = allSpans.some((s) => s.status === "error");

  return {
    trace_id: traceId,
    endpoint: endpointName,
    total_duration_ms: rootSpan?.duration_ms || 0,
    status_code: hasError ? 500 : 200,
    timestamp: rootSpan?.start_time || allSpans[0]?.start_time,
    error: errorInfo,
    bottleneck,
    spans: rootSpans,
  };
}

// ── Config file writer ──

function writeConfig(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readConfig(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  ApiClient,
  loadConfig,
  writeConfig,
  readConfig,
  findProjectRc,
  findLocalDb,
};
