"use strict";

/**
 * depct errors — "What's broken?"
 *
 * Shows error groups with full evidence: causal chains, arg shapes,
 * blast radius, frequency trends.
 *
 * Usage:
 *   depct errors --json
 *   depct errors --since 2d --json
 *   depct errors --function resolvePaymentMethod --json
 *   depct errors --trending --json
 *   depct errors --severity critical --json
 */

const { ApiClient } = require("../api-client.cjs");
const { parseSince } = require("../parse-args.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct errors${out.c.reset} ${out.c.dim}— What's broken?${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct errors [options]

${out.c.bold}Options${out.c.reset}
  --since <duration>     Filter by time (e.g. 1h, 2d, 1w)
  --function <name>      Filter by function name
  --trending             Show only errors with rising trend
  --severity <level>     Filter: critical, high, medium, low
  --limit <n>            Max results (default: 20)
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct errors --json${out.c.reset}
  ${out.c.cyan}depct errors --since 2d --trending --json${out.c.reset}
  ${out.c.cyan}depct errors --function resolvePaymentMethod --json${out.c.reset}
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
  if (ctx.flags.function) params.function = ctx.flags.function;
  if (ctx.flags.trending) params.trending = true;
  if (ctx.flags.severity) params.severity = ctx.flags.severity;
  if (ctx.flags.limit) params.limit = parseInt(ctx.flags.limit, 10);

  const spin = ctx.json ? null : out.spinner("Fetching error groups");
  let data;
  try {
    data = await client.get("/api/error-groups", params);
  } finally {
    if (spin) spin.stop();
  }

  // Normalize response
  const errorGroups = data.error_groups || data.errorGroups || data || [];
  const summary = data.summary || buildSummary(errorGroups);

  if (ctx.json) {
    out.json({
      error_groups: errorGroups.map(normalizeGroup),
      summary,
      _meta: {
        command: "errors",
        timestamp: new Date().toISOString(),
        filters: params,
      },
    });
    return;
  }

  // Human-readable output
  renderHuman(errorGroups, summary, params);
}

function normalizeGroup(g) {
  // Frequency: accept both local query format and remote API format
  const freq = g.frequency || {};
  const total = freq.total || g.occurrence_count || g.count || 0;
  const lastHour = freq.last_hour || freq.lastHour || freq.last_1h || 0;
  const lastDay = freq.last_day || freq.lastDay || freq.last_24h || 0;
  const lastWeek = freq.last_week || freq.lastWeek || freq.last_7d || 0;

  return {
    group_id: g.group_id || g.groupId || g.id,
    severity: g.severity || "medium",
    trend: g.trend || "stable",
    error_class: g.error_class || g.errorClass || g.class || "Error",
    message_template: g.message_template || g.messageTemplate || g.message || "",
    trigger: {
      function: g.trigger?.function || g.function || null,
      file: g.trigger?.file || g.file || null,
      line: g.trigger?.line || g.line || null,
    },
    causal_chain: g.causal_chain || g.causalChain || [],
    frequency: {
      total,
      last_hour: lastHour,
      last_day: lastDay,
      last_week: lastWeek,
    },
    first_seen: g.first_seen || g.firstSeen || null,
    last_seen: g.last_seen || g.lastSeen || null,
    args_shape_at_failure: g.args_shape_at_failure || g.argsShapeAtFailure || null,
    args_shape_when_succeeds: g.args_shape_when_succeeds || g.argsShapeWhenSucceeds || null,
    shape_diff: g.shape_diff || null,
    preceding_successes: g.preceding_successes || 0,
    blast_radius: g.blast_radius || g.blastRadius || {
      affected_endpoints: [],
      affected_traces: 0,
      impact_pct: 0,
    },
  };
}

function buildSummary(groups) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalOccurrences = 0;
  let trendingUp = 0;

  for (const g of groups) {
    const sev = g.severity || "medium";
    if (bySeverity[sev] !== undefined) bySeverity[sev]++;
    totalOccurrences += g.frequency?.total || g.occurrence_count || g.count || 0;
    if (g.trend === "spiking" || g.trend === "new" || g.trend === "regressing") trendingUp++;
  }

  return {
    total_groups: groups.length,
    total_occurrences: totalOccurrences,
    by_severity: bySeverity,
    trending_up: trendingUp,
  };
}

function renderHuman(groups, summary, params) {
  out.heading("Error Groups");

  if (params.since || params.function || params.severity) {
    const filters = [];
    if (params.since) filters.push(`since ${params.since}`);
    if (params.function) filters.push(`fn: ${params.function}`);
    if (params.severity) filters.push(`severity: ${params.severity}`);
    out.info(`Filters: ${filters.join(", ")}`);
  }

  out.blank();

  // Summary bar
  const s = summary;
  const { c } = out;
  out.line(
    `  ${c.bold}${s.total_groups}${c.reset} groups  ` +
    `${c.red}${s.by_severity.critical} crit${c.reset}  ` +
    `${c.yellow}${s.by_severity.high} high${c.reset}  ` +
    `${c.dim}${s.by_severity.medium} med  ${s.by_severity.low} low${c.reset}  ` +
    `${s.trending_up > 0 ? c.red + s.trending_up + " rising" + c.reset : ""}`
  );
  out.blank();
  out.divider();

  if (groups.length === 0) {
    out.blank();
    out.success("No errors found. Clean slate.");
    out.blank();
    return;
  }

  for (const raw of groups) {
    const g = normalizeGroup(raw);
    const sevColor = out.severityColor(g.severity);
    const trend = out.trendIcon(g.trend);

    out.blank();
    out.line(
      `  ${sevColor}${g.severity.toUpperCase().padEnd(8)}${c.reset} ` +
      `${trend} ` +
      `${c.bold}${g.error_class}${c.reset}: ${g.message_template}`
    );

    out.line(
      `  ${c.dim}ID:${c.reset} ${g.group_id}  ` +
      `${c.dim}Freq:${c.reset} ${g.frequency.total} total (${g.frequency.last_hour} last hr)  ` +
      `${c.dim}Last:${c.reset} ${g.last_seen ? out.formatAge(g.last_seen) : "unknown"}`
    );

    if (g.trigger.function) {
      out.line(
        `  ${c.dim}Trigger:${c.reset} ${c.cyan}${g.trigger.function}${c.reset}` +
        (g.trigger.file
          ? ` ${c.dim}at${c.reset} ${g.trigger.file}${g.trigger.line ? ":" + g.trigger.line : ""}`
          : "")
      );
    }

    if (g.causal_chain && g.causal_chain.length > 0) {
      const chainStr = g.causal_chain.map((f) => {
        const nodeId = typeof f === "string" ? f : f.node_id || "?";
        return c.cyan + nodeId + c.reset;
      }).join(" -> ");
      out.line(`  ${c.dim}Chain:${c.reset} ${chainStr}`);
    }

    if (g.blast_radius && g.blast_radius.affected_endpoints?.length > 0) {
      const impactPct = g.blast_radius.impact_pct || g.blast_radius.affected_users_pct || 0;
      out.line(
        `  ${c.dim}Blast:${c.reset} ${g.blast_radius.affected_endpoints.length} endpoint(s), ` +
        `${g.blast_radius.affected_traces || 0} traces (${impactPct}% of traffic)`
      );
    }

    out.divider();
  }

  out.blank();
}

module.exports = { execute };
