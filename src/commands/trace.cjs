"use strict";

/**
 * depct trace — Full execution trace
 *
 * Usage:
 *   depct trace /api/checkout --json
 *   depct trace /api/checkout --slowest --since 1h --json
 *   depct trace /api/checkout --errors --json
 *   depct trace --id <trace-id> --json
 */

const { ApiClient } = require("../api-client.cjs");
const { parseSince } = require("../parse-args.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct trace${out.c.reset} ${out.c.dim}— Full execution trace${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct trace <endpoint> [options]
  depct trace --id <trace-id> [options]

${out.c.bold}Options${out.c.reset}
  --id <trace-id>        Show a specific trace
  --slowest              Show slowest trace
  --errors               Show only traces with errors
  --since <duration>     Filter by time (e.g. 1h, 2d)
  --limit <n>            Max results (default: 10)
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct trace /api/checkout --json${out.c.reset}
  ${out.c.cyan}depct trace /api/checkout --slowest --since 1h --json${out.c.reset}
  ${out.c.cyan}depct trace --id tr_abc123 --json${out.c.reset}
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

  // Single trace by ID
  if (ctx.flags.id) {
    const spin = ctx.json ? null : out.spinner(`Fetching trace ${ctx.flags.id}`);
    let data;
    try {
      data = await client.get(`/api/traces/${ctx.flags.id}`);
    } finally {
      if (spin) spin.stop();
    }

    const trace = normalizeTrace(data);

    if (ctx.json) {
      out.json({
        ...trace,
        _meta: { command: "trace", timestamp: new Date().toISOString() },
      });
      return;
    }

    renderSingleTrace(trace);
    return;
  }

  // Query traces for endpoint
  const endpoint = ctx.args[0];
  if (!endpoint) {
    out.error("Missing endpoint. Usage: depct trace <endpoint> or depct trace --id <trace-id>");
    process.exitCode = 1;
    return;
  }

  const params = { endpoint };
  if (ctx.flags.since) params.since = parseSince(ctx.flags.since).toISOString();
  if (ctx.flags.slowest) params.sort = "duration_desc";
  if (ctx.flags.errors) params.errors_only = true;
  if (ctx.flags.limit) params.limit = parseInt(ctx.flags.limit, 10);

  const spin = ctx.json ? null : out.spinner(`Fetching traces for ${endpoint}`);
  let data;
  try {
    data = await client.get("/api/traces", params);
  } finally {
    if (spin) spin.stop();
  }

  const traces = (data.traces || data || []).map(normalizeTrace);

  if (ctx.json) {
    out.json({
      endpoint,
      traces,
      _meta: {
        command: "trace",
        timestamp: new Date().toISOString(),
        filters: params,
        count: traces.length,
      },
    });
    return;
  }

  renderTraceList(endpoint, traces);
}

function normalizeTrace(t) {
  return {
    trace_id: t.trace_id || t.traceId || t.id,
    endpoint: t.endpoint || t.path || t.url,
    method: t.method || "GET",
    total_duration_ms: t.total_duration_ms || t.totalDuration || t.duration || 0,
    status_code: t.status_code || t.statusCode || 200,
    timestamp: t.timestamp || t.started_at || t.startedAt || null,
    error: t.error || null,
    spans: (t.spans || []).map(normalizeSpan),
  };
}

function normalizeSpan(s, depth = 0) {
  return {
    span_id: s.span_id || s.spanId || s.id,
    name: s.name || s.function || s.operation,
    type: s.type || "function",
    duration_ms: s.duration_ms || s.duration || 0,
    error: s.error || null,
    children: (s.children || s.spans || []).map((c) => normalizeSpan(c, depth + 1)),
  };
}

function renderSingleTrace(trace) {
  const { c } = out;

  out.heading(`Trace: ${trace.trace_id}`);
  out.label("Endpoint", `${trace.method} ${trace.endpoint}`);
  out.label("Status", statusColor(trace.status_code));
  out.label("Duration", out.formatDuration(trace.total_duration_ms));
  if (trace.timestamp) out.label("Time", out.formatAge(trace.timestamp));

  if (trace.error) {
    out.blank();
    out.line(`  ${c.red}Error: ${trace.error}${c.reset}`);
  }

  if (trace.spans.length > 0) {
    out.blank();
    out.subheading("Spans");
    renderSpanTree(trace.spans, 0, trace.total_duration_ms);
  }

  out.blank();
}

function renderSpanTree(spans, depth, totalMs) {
  const { c } = out;
  for (const span of spans) {
    const pct = totalMs > 0 ? ((span.duration_ms / totalMs) * 100).toFixed(0) : 0;
    const bar = barChart(span.duration_ms, totalMs, 20);
    const prefix = "  ".repeat(depth + 1);
    const errMark = span.error ? `${c.red} [ERR]${c.reset}` : "";

    out.line(
      `${prefix}${c.cyan}${span.name}${c.reset} ` +
      `${c.dim}${out.formatDuration(span.duration_ms)} (${pct}%)${c.reset} ` +
      `${bar}${errMark}`
    );

    if (span.children && span.children.length > 0) {
      renderSpanTree(span.children, depth + 1, totalMs);
    }
  }
}

function renderTraceList(endpoint, traces) {
  const { c } = out;

  out.heading(`Traces: ${endpoint}`);
  out.info(`${traces.length} trace(s) found`);
  out.blank();

  if (traces.length === 0) {
    out.info("No traces found for this endpoint.");
    out.blank();
    return;
  }

  out.table(
    traces.map((t) => ({
      id: t.trace_id,
      status: statusColorRaw(t.status_code),
      duration: out.formatDuration(t.total_duration_ms),
      spans: String(countSpans(t.spans)),
      error: t.error ? `${c.red}${t.error.slice(0, 40)}${c.reset}` : `${c.dim}none${c.reset}`,
      time: t.timestamp ? out.formatAge(t.timestamp) : "",
    })),
    [
      { key: "id", label: "Trace ID" },
      { key: "status", label: "Status" },
      { key: "duration", label: "Duration", align: "right" },
      { key: "spans", label: "Spans", align: "right" },
      { key: "error", label: "Error" },
      { key: "time", label: "When" },
    ]
  );

  out.blank();
}

function countSpans(spans) {
  let count = spans.length;
  for (const s of spans) {
    if (s.children) count += countSpans(s.children);
  }
  return count;
}

function statusColor(code) {
  const { c } = out;
  if (code >= 500) return `${c.red}${code}${c.reset}`;
  if (code >= 400) return `${c.yellow}${code}${c.reset}`;
  return `${c.green}${code}${c.reset}`;
}

function statusColorRaw(code) {
  return statusColor(code);
}

function barChart(value, max, width) {
  const { c } = out;
  if (max === 0) return "";
  const filled = Math.max(1, Math.round((value / max) * width));
  const color = value / max > 0.8 ? c.red : value / max > 0.5 ? c.yellow : c.green;
  return `${color}${"█".repeat(filled)}${c.dim}${"░".repeat(Math.max(0, width - filled))}${c.reset}`;
}

module.exports = { execute };
