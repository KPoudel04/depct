"use strict";

/**
 * depct anomalies — "What changed?"
 *
 * Detects behavioral anomalies by comparing current function behavior
 * against historical baselines: error rate spikes, latency spikes,
 * traffic changes, and gone-silent functions.
 *
 * Usage:
 *   depct anomalies --json
 *   depct anomalies --since 1h --json
 *   depct anomalies --severity critical --json
 */

const { ApiClient } = require("../api-client.cjs");
const { parseSince } = require("../parse-args.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct anomalies${out.c.reset} ${out.c.dim}— What changed?${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct anomalies [options]

${out.c.bold}Options${out.c.reset}
  --since <duration>     Recent window (default: 1h)
  --severity <level>     Filter: critical, warning, info
  --limit <n>            Max results (default: 50)
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct anomalies --json${out.c.reset}
  ${out.c.cyan}depct anomalies --severity critical --json${out.c.reset}
  ${out.c.cyan}depct anomalies --since 2h --json${out.c.reset}
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
  if (ctx.flags.severity) params.severity = ctx.flags.severity;
  if (ctx.flags.limit) params.limit = parseInt(ctx.flags.limit, 10);

  const spin = ctx.json ? null : out.spinner("Detecting anomalies");
  let data;
  try {
    data = await client.get("/api/anomalies", params);
  } finally {
    if (spin) spin.stop();
  }

  const anomalies = data.anomalies || [];
  const summary = data.summary || { total: 0, critical: 0, warning: 0, info: 0 };

  if (ctx.json) {
    out.json({
      anomalies,
      summary,
      _meta: {
        command: "anomalies",
        timestamp: new Date().toISOString(),
        filters: params,
      },
    });
    return;
  }

  // Human-readable output
  renderHuman(anomalies, summary, params);
}

function renderHuman(anomalies, summary, params) {
  out.heading("Anomaly Detection");

  if (params.since || params.severity) {
    const filters = [];
    if (params.since) filters.push(`since ${params.since}`);
    if (params.severity) filters.push(`severity: ${params.severity}`);
    out.info(`Filters: ${filters.join(", ")}`);
  }

  out.blank();

  const { c } = out;
  out.line(
    `  ${c.bold}${summary.total}${c.reset} anomalies  ` +
    `${c.red}${summary.critical} critical${c.reset}  ` +
    `${c.yellow}${summary.warning} warning${c.reset}  ` +
    `${c.dim}${summary.info} info${c.reset}`
  );
  out.blank();
  out.divider();

  if (anomalies.length === 0) {
    out.blank();
    out.info("No anomalies detected. Need more runtime data to establish baselines and detect deviations.");
    out.blank();
    return;
  }

  for (const a of anomalies) {
    const sevColor = a.severity === "critical" ? c.bgRed + c.white + c.bold
      : a.severity === "warning" ? c.yellow + c.bold
      : c.dim;

    const typeLabel = a.type.replace(/_/g, " ").toUpperCase();

    out.blank();
    out.line(
      `  ${sevColor}${a.severity.toUpperCase().padEnd(10)}${c.reset} ` +
      `${c.bold}${typeLabel}${c.reset}`
    );
    out.line(
      `  ${c.cyan}${a.function}${c.reset}` +
      (a.file ? ` ${c.dim}at${c.reset} ${a.file}` : "")
    );
    out.line(`  ${c.dim}${a.description}${c.reset}`);

    if (a.current_value !== undefined && a.baseline_value !== undefined) {
      out.line(
        `  ${c.dim}Current:${c.reset} ${a.current_value}  ` +
        `${c.dim}Baseline:${c.reset} ${a.baseline_value}  ` +
        `${c.dim}Ratio:${c.reset} ${a.ratio}x`
      );
    }

    out.divider();
  }

  out.blank();
}

module.exports = { execute };
