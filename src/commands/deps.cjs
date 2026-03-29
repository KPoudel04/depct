"use strict";

/**
 * depct deps — "What external services does this app depend on?"
 *
 * Shows external dependencies (HTTP outbound calls, database queries, caches)
 * with health scores, latency, and error rates.
 *
 * Usage:
 *   depct deps --json
 *   depct deps --since 1d --json
 *   depct deps --type http --json
 */

const { ApiClient } = require("../api-client.cjs");
const { parseSince } = require("../parse-args.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct deps${out.c.reset} ${out.c.dim}— What external services does this app depend on?${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct deps [options]

${out.c.bold}Options${out.c.reset}
  --since <duration>     Filter by time (e.g. 1h, 2d, 1w)
  --type <type>          Filter by type: http, database, cache
  --limit <n>            Max results (default: 50)
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct deps --json${out.c.reset}
  ${out.c.cyan}depct deps --since 1d --type http --json${out.c.reset}
`;

async function execute(ctx) {
  if (ctx.flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const client = new ApiClient({
    serverUrl: ctx.flags.serverUrl,
    project: ctx.flags.project,
    local: ctx.flags.local,
  });

  const params = {};
  if (ctx.flags.since) {
    params.since = parseSince(ctx.flags.since).toISOString();
  }
  if (ctx.flags.type) params.type = ctx.flags.type;
  if (ctx.flags.limit) params.limit = parseInt(ctx.flags.limit, 10);

  const spin = ctx.json ? null : out.spinner("Scanning external dependencies");
  let data;
  try {
    data = await client.get("/api/deps", params);
  } finally {
    if (spin) spin.stop();
  }

  const dependencies = (data.dependencies || []).map(normalizeDep);
  const summary = data.summary || buildSummary(dependencies);

  if (ctx.json) {
    out.json({
      dependencies,
      summary,
      _meta: {
        command: "deps",
        timestamp: new Date().toISOString(),
        filters: params,
        note: data.note || undefined,
      },
    });
    return;
  }

  renderHuman(dependencies, summary, params, data.note);
}

function normalizeDep(d) {
  return {
    name: d.name || "unknown",
    type: d.type || "http",
    health: d.health || "healthy",
    calls_24h: d.calls_24h || d.calls || 0,
    error_rate: d.error_rate != null ? d.error_rate : 0,
    p95_ms: d.p95_ms != null ? d.p95_ms : 0,
    avg_ms: d.avg_ms != null ? d.avg_ms : 0,
    last_seen: d.last_seen || null,
    methods: d.methods || [],
  };
}

function buildSummary(deps) {
  return {
    total: deps.length,
    healthy: deps.filter((d) => d.health === "healthy").length,
    degraded: deps.filter((d) => d.health === "degraded").length,
    critical: deps.filter((d) => d.health === "critical").length,
  };
}

function healthColor(health) {
  const { c } = out;
  switch (health) {
    case "healthy":
      return c.green;
    case "degraded":
      return c.yellow;
    case "critical":
      return c.red;
    default:
      return c.dim;
  }
}

function healthIcon(health) {
  switch (health) {
    case "healthy":
      return "\u2713";
    case "degraded":
      return "\u26a0";
    case "critical":
      return "\u2717";
    default:
      return "?";
  }
}

function renderHuman(deps, summary, params, note) {
  const { c } = out;

  out.heading("External Dependencies");

  if (params.since || params.type) {
    const filters = [];
    if (params.since) filters.push(`since ${params.since}`);
    if (params.type) filters.push(`type: ${params.type}`);
    out.info(`Filters: ${filters.join(", ")}`);
  }

  out.blank();

  // Summary bar
  out.line(
    `  ${c.bold}${summary.total}${c.reset} dependencies  ` +
    `${c.green}${summary.healthy} healthy${c.reset}  ` +
    `${c.yellow}${summary.degraded} degraded${c.reset}  ` +
    `${c.red}${summary.critical} critical${c.reset}`
  );
  out.blank();
  out.divider();

  if (deps.length === 0) {
    out.blank();
    out.info("No external calls captured yet. When your app calls APIs, databases, or caches, they'll appear here.");
    out.blank();
    return;
  }

  out.blank();

  out.table(
    deps.map((d) => ({
      health: `${healthColor(d.health)}${healthIcon(d.health)} ${d.health.toUpperCase()}${c.reset}`,
      name: `${c.bold}${d.name}${c.reset}`,
      type: `${c.dim}${d.type}${c.reset}`,
      calls: String(d.calls_24h),
      error_rate: `${d.error_rate > 5 ? c.red : d.error_rate > 1 ? c.yellow : c.dim}${d.error_rate.toFixed(1)}%${c.reset}`,
      p95: out.formatDuration(d.p95_ms),
      avg: out.formatDuration(d.avg_ms),
    })),
    [
      { key: "health", label: "Health" },
      { key: "name", label: "Service" },
      { key: "type", label: "Type" },
      { key: "calls", label: "Calls 24h", align: "right" },
      { key: "error_rate", label: "Err %", align: "right" },
      { key: "p95", label: "P95", align: "right" },
      { key: "avg", label: "Avg", align: "right" },
    ]
  );

  out.blank();
}

module.exports = { execute };
