"use strict";

/**
 * depct inspect — Deep dive on a function
 *
 * Usage:
 *   depct inspect resolvePaymentMethod --json
 *   depct inspect resolvePaymentMethod --callers --json
 */

const { ApiClient } = require("../api-client.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct inspect${out.c.reset} ${out.c.dim}— Deep dive on a function${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct inspect <function-name> [options]

${out.c.bold}Options${out.c.reset}
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct inspect resolvePaymentMethod --json${out.c.reset}
`;

async function execute(ctx) {
  if (ctx.flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const fnName = ctx.args[0];
  if (!fnName) {
    out.error("Missing function name. Usage: depct inspect <function-name>");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({
    serverUrl: ctx.flags.serverUrl,
    project: ctx.flags.project,
    local: ctx.flags.local,
  });

  const spin = ctx.json ? null : out.spinner(`Inspecting ${fnName}`);
  let data;
  try {
    data = await client.get("/api/inspect", { function: fnName });
  } finally {
    if (spin) spin.stop();
  }

  const result = normalizeInspection(data, fnName);

  if (ctx.json) {
    out.json({
      ...result,
      _meta: {
        command: "inspect",
        timestamp: new Date().toISOString(),
        query: fnName,
      },
    });
    return;
  }

  renderHuman(result);
}

function normalizeInspection(d, fnName) {
  return {
    function: d.function || d.name || fnName,
    found: d.found !== undefined ? d.found : true,
    file: d.file || d.filePath || null,
    line: d.line || d.lineNumber || null,
    call_profile: {
      invocations: d.call_profile?.invocations || d.callProfile?.invocations || d.invocations || 0,
      error_rate: d.call_profile?.error_rate || d.callProfile?.errorRate || d.errorRate || 0,
      p50_ms: d.call_profile?.p50_ms || d.callProfile?.p50 || d.p50 || 0,
      p95_ms: d.call_profile?.p95_ms || d.callProfile?.p95 || d.p95 || 0,
      p99_ms: d.call_profile?.p99_ms || d.callProfile?.p99 || d.p99 || 0,
    },
    callers: d.callers || [],
    callees: d.callees || [],
    errors: (d.errors || []).map((e) => ({
      group_id: e.group_id || e.groupId || e.id,
      error_class: e.error_class || e.errorClass || e.class || "Error",
      message: e.message || "",
      count: e.count || 0,
    })),
    arg_shapes: {
      success: d.arg_shapes?.success || d.argShapes?.success || null,
      failure: d.arg_shapes?.failure || d.argShapes?.failure || null,
    },
    test_coverage: d.test_coverage || d.testCoverage || {
      covered: false,
      test_files: [],
      line_coverage_pct: 0,
    },
  };
}

function renderHuman(result) {
  const { c } = out;

  out.heading(`Function: ${result.function}`);

  if (result.file) {
    out.label("Location", `${result.file}${result.line ? ":" + result.line : ""}`);
  }

  out.blank();
  out.subheading("Call Profile");
  out.label("Invocations", result.call_profile.invocations.toLocaleString());
  out.label("Error Rate", `${(result.call_profile.error_rate * 100).toFixed(1)}%`);
  out.label(
    "Latency",
    `p50=${out.formatDuration(result.call_profile.p50_ms)} ` +
    `p95=${out.formatDuration(result.call_profile.p95_ms)} ` +
    `p99=${out.formatDuration(result.call_profile.p99_ms)}`
  );

  if (result.callers.length > 0) {
    out.blank();
    out.subheading("Callers");
    for (const caller of result.callers) {
      const name = typeof caller === "string" ? caller : caller.function || caller.name;
      const count = typeof caller === "object" ? caller.count : null;
      out.indent(
        `${c.cyan}${name}${c.reset}${count ? c.dim + ` (${count} calls)` + c.reset : ""}`
      );
    }
  }

  if (result.callees.length > 0) {
    out.blank();
    out.subheading("Callees");
    for (const callee of result.callees) {
      const name = typeof callee === "string" ? callee : callee.function || callee.name;
      const count = typeof callee === "object" ? callee.count : null;
      out.indent(
        `${c.cyan}${name}${c.reset}${count ? c.dim + ` (${count} calls)` + c.reset : ""}`
      );
    }
  }

  if (result.errors.length > 0) {
    out.blank();
    out.subheading("Errors");
    for (const err of result.errors) {
      out.indent(
        `${c.red}${err.error_class}${c.reset}: ${err.message} ` +
        `${c.dim}(${err.count}x, ${err.group_id})${c.reset}`
      );
    }
  }

  if (result.arg_shapes.success || result.arg_shapes.failure) {
    out.blank();
    out.subheading("Arg Shapes");
    if (result.arg_shapes.success) {
      out.label("When succeeds", JSON.stringify(result.arg_shapes.success));
    }
    if (result.arg_shapes.failure) {
      out.label("When fails", JSON.stringify(result.arg_shapes.failure));
    }
  }

  const cov = result.test_coverage;
  out.blank();
  out.subheading("Test Coverage");
  out.label(
    "Status",
    cov.covered
      ? `${c.green}Covered${c.reset} (${cov.line_coverage_pct}%)`
      : `${c.red}Not covered${c.reset}`
  );
  if (cov.test_files && cov.test_files.length > 0) {
    for (const tf of cov.test_files) {
      out.indent(`${c.dim}${tf}${c.reset}`);
    }
  }

  out.blank();
}

module.exports = { execute };
