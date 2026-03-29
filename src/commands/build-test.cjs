"use strict";

/**
 * depct build-test — THE LEAD FEATURE
 *
 * Generates test candidates from error evidence. This is the crown jewel
 * of the depct CLI. Its JSON output must be so well-structured that any
 * LLM can immediately write a test from it.
 *
 * Pipeline:
 *   1. Test suite detection (jest/vitest/mocha/tap/ava)
 *   2. Existing coverage scan
 *   3. Error cross-reference
 *   4. Candidate ranking by frequency x trend x coverage_gap x blast_radius
 *   5. Structured output with reproduction steps
 *
 * Usage:
 *   depct build-test --json
 *   depct build-test --error eg_001 --json
 *   depct build-test --value high --json
 *   depct build-test --limit 5 --json
 */

const fs = require("node:fs");
const path = require("node:path");
const { ApiClient } = require("../api-client.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct build-test${out.c.reset} ${out.c.dim}— Test candidates from error evidence${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct build-test [options]

${out.c.bold}Options${out.c.reset}
  --error <id>           Build test for specific error group
  --value <level>        Filter: critical, high, medium, low
  --limit <n>            Max candidates (default: 10)
  --format <fmt>         Test format hint: jest, vitest, mocha, tap, ava
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct build-test --json${out.c.reset}
  ${out.c.cyan}depct build-test --error eg_001 --json${out.c.reset}
  ${out.c.cyan}depct build-test --value high --limit 5 --json${out.c.reset}

${out.c.bold}Output${out.c.reset}
  Each candidate includes reproduction args, trigger location,
  causal chain, existing coverage gaps, and a suggested test
  skeleton that an AI agent can immediately implement.
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

  // Step 1: Detect test framework
  const spin = ctx.json ? null : out.spinner("Analyzing project");
  const testFramework = ctx.flags.format || detectTestFramework();
  if (spin) spin.update("Fetching error evidence");

  // Step 2-4: Get candidates from server
  const params = {};
  if (ctx.flags.error) params.error_group_id = ctx.flags.error;
  if (ctx.flags.value) params.value = ctx.flags.value;
  if (ctx.flags.limit) params.limit = parseInt(ctx.flags.limit, 10);
  if (testFramework) params.test_framework = testFramework;

  let data;
  try {
    data = await client.get("/api/build-test", params);
  } finally {
    if (spin) spin.stop();
  }

  const rawCandidates = data.candidates || data || [];

  // If candidates already have the v2 local query structure (error + reproduction),
  // pass through directly. Otherwise normalize from remote API format.
  const candidates = rawCandidates[0]?.reproduction
    ? rawCandidates
    : rawCandidates.map((c, i) => normalizeCandidate(c, i, testFramework));

  const result = {
    candidates,
    summary: data.summary || {
      total_candidates: candidates.length,
      by_value: countByValue(candidates),
    },
    _meta: {
      command: "build-test",
      timestamp: new Date().toISOString(),
      filters: params,
    },
  };

  if (ctx.json) {
    out.json(result);
    return;
  }

  renderHuman(result);
}

function normalizeCandidate(c, index, framework) {
  const score = c.score || computeScore(c);
  const scoreBreakdown = c.score_breakdown || c.scoreBreakdown || {
    frequency_weight: c.frequency?.total || 0,
    trend_weight: c.trend === "rising" ? 3 : c.trend === "stable" ? 1 : 0,
    coverage_gap_weight: c.existing_coverage?.covered ? 0 : 5,
    blast_radius_weight: c.blast_radius?.affected_endpoints?.length || 0,
  };

  // Extract function/file/line from wherever they live
  const fn = c.trigger?.function || c.reproduces?.function || c.function || null;
  const file = c.trigger?.file || c.reproduces?.file || c.file || null;
  const line = c.trigger?.line || c.reproduces?.line || c.line || null;
  const errClass = c.reproduces?.error_class || c.error_class || c.errorClass || "Error";
  const msg = c.reproduces?.message_template || c.reproduces?.message || c.message_template || c.message || "";
  const causalChain = c.causal_chain || c.causalChain || c.trigger?.call_path || [];
  const groupId = c.error_group_id || c.errorGroupId || c.group_id || c.reproduces?.error_group_id || null;

  return {
    candidate_id: c.candidate_id || c.candidateId || `tc_${String(index + 1).padStart(3, "0")}`,
    value: c.value || valueFromScore(score),
    score,
    score_breakdown: scoreBreakdown,
    reproduces: {
      description: c.reproduces?.description || c.description ||
        `${errClass}: ${msg || "unknown"}`,
      error_class: errClass,
      message_template: msg,
      args_that_trigger: c.reproduces?.args_that_trigger || c.trigger?.args_that_fail || c.argsShapeAtFailure || c.args_shape_at_failure || null,
      args_that_succeed: c.reproduces?.args_that_succeed || c.trigger?.args_that_succeed || c.argsShapeWhenSucceeds || c.args_shape_when_succeeds || null,
    },
    trigger: {
      function: fn,
      file: file,
      line: line,
      module: c.trigger?.module || null,
    },
    frequency: {
      total: c.frequency?.total || c.frequency?.occurrences_total || c.count || 0,
      last_hour: c.frequency?.last_hour || c.frequency?.lastHour || c.frequency?.last_1h || 0,
      last_day: c.frequency?.last_day || c.frequency?.lastDay || c.frequency?.last_24h || c.frequency?.occurrences_24h || 0,
      last_week: c.frequency?.last_week || c.frequency?.lastWeek || c.frequency?.last_7d || 0,
      trend: c.frequency?.trend || c.trend || "stable",
    },
    existing_coverage: {
      covered: c.existing_coverage?.covered ?? c.covered ?? false,
      test_files: c.existing_coverage?.test_files || c.testFiles || [],
      line_coverage_pct: c.existing_coverage?.line_coverage_pct || c.lineCoverage || 0,
      gap_description: c.existing_coverage?.gap_description ||
        (c.existing_coverage?.covered ? "Covered but error still occurs" : "No existing test coverage"),
    },
    suggested_test: c.suggested_test || buildSuggestedTest(
      { trigger: { function: fn, file }, error_class: errClass, message_template: msg, reproduces: c.reproduces },
      framework
    ),
    fix_hint: c.fix_hint || c.fixHint || buildFixHint(c),
    error_group_id: groupId,
    causal_chain: causalChain,
    blast_radius: c.blast_radius || c.blastRadius || {
      affected_endpoints: [],
      affected_users_pct: 0,
      downstream_errors: 0,
    },
  };
}

function buildSuggestedTest(c, framework) {
  if (c.suggested_test) return c.suggested_test;

  const fn = c.trigger?.function || c.function || "targetFunction";
  const file = c.trigger?.file || c.file || "unknown";
  const errorClass = c.error_class || c.errorClass || "Error";
  const message = c.message_template || c.message || "";
  const args = c.reproduces?.args_that_trigger || c.args_shape_at_failure || null;

  const fw = framework || "jest";

  let test_file = "";
  if (file && file !== "unknown") {
    const parsed = path.parse(file);
    test_file = path.join(
      parsed.dir,
      "__tests__",
      `${parsed.name}.test${parsed.ext || ".js"}`
    );
  }

  // Framework-specific skeleton
  const skeletons = {
    jest: {
      framework: "jest",
      test_file,
      describe_block: fn,
      test_name: `should handle ${errorClass}: ${message.slice(0, 60)}`,
      setup: `// Import the function under test\nconst { ${fn} } = require('${file}');`,
      body: buildTestBody(fn, args, errorClass, message),
      assertions: [
        `expect(${fn}).toBeDefined()`,
        args ? `expect(() => ${fn}(${formatArgs(args)})).toThrow(${errorClass})` : `expect(() => ${fn}()).toThrow()`,
      ],
    },
    vitest: {
      framework: "vitest",
      test_file: test_file.replace(".test.", ".test."),
      describe_block: fn,
      test_name: `should handle ${errorClass}: ${message.slice(0, 60)}`,
      setup: `import { describe, it, expect } from 'vitest';\nimport { ${fn} } from '${file}';`,
      body: buildTestBody(fn, args, errorClass, message),
      assertions: [
        `expect(${fn}).toBeDefined()`,
        args ? `expect(() => ${fn}(${formatArgs(args)})).toThrow(${errorClass})` : `expect(() => ${fn}()).toThrow()`,
      ],
    },
    mocha: {
      framework: "mocha",
      test_file,
      describe_block: fn,
      test_name: `should handle ${errorClass}: ${message.slice(0, 60)}`,
      setup: `const { expect } = require('chai');\nconst { ${fn} } = require('${file}');`,
      body: buildTestBody(fn, args, errorClass, message),
      assertions: [
        `expect(${fn}).to.be.a('function')`,
        args ? `expect(() => ${fn}(${formatArgs(args)})).to.throw(${errorClass})` : `expect(() => ${fn}()).to.throw()`,
      ],
    },
  };

  return skeletons[fw] || skeletons.jest;
}

function buildTestBody(fn, args, errorClass, message) {
  const lines = [];
  lines.push(`// This test reproduces ${errorClass}: ${message.slice(0, 80)}`);
  lines.push(`// Based on observed failure args from production`);
  if (args) {
    lines.push(`const failingArgs = ${JSON.stringify(args, null, 2)};`);
    lines.push(`// Call with args that trigger the error`);
    lines.push(`expect(() => ${fn}(...failingArgs)).toThrow();`);
  } else {
    lines.push(`// TODO: Add specific args that reproduce the error`);
    lines.push(`expect(() => ${fn}()).toThrow();`);
  }
  return lines.join("\n");
}

function buildFixHint(c) {
  const chain = c.causal_chain || c.causalChain || [];
  const args = c.args_shape_at_failure || c.reproduces?.args_that_trigger;
  const successArgs = c.args_shape_when_succeeds || c.reproduces?.args_that_succeed;

  const hints = [];

  if (args && successArgs) {
    hints.push(
      `Compare failing args shape ${JSON.stringify(args)} with succeeding shape ${JSON.stringify(successArgs)} — the difference likely reveals the bug.`
    );
  }

  if (chain.length > 1) {
    hints.push(
      `Error propagates through chain: ${chain.join(" -> ")}. Fix at the root: ${chain[0]}.`
    );
  }

  if (hints.length === 0) {
    hints.push("Examine the function's error handling for the failing arg pattern.");
  }

  return hints.join(" ");
}

function formatArgs(args) {
  if (!args) return "";
  if (Array.isArray(args)) {
    return args.map((a) => JSON.stringify(a)).join(", ");
  }
  return JSON.stringify(args);
}

function computeScore(c) {
  const freq = Math.min(100, c.frequency?.total || c.count || 0);
  const trendMult = c.trend === "rising" ? 3 : c.trend === "stable" ? 1 : 0.5;
  const coverageGap = c.existing_coverage?.covered ? 0.5 : 3;
  const blast = Math.min(5, c.blast_radius?.affected_endpoints?.length || 0);

  return Math.round((freq * trendMult + coverageGap * 20 + blast * 10) * 10) / 10;
}

function valueFromScore(score) {
  if (score >= 200) return "critical";
  if (score >= 100) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function countByValue(candidates) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of candidates) {
    if (counts[c.value] !== undefined) counts[c.value]++;
  }
  return counts;
}

function estimateCoverageGain(candidates) {
  const uncovered = candidates.filter((c) => !c.existing_coverage.covered);
  return {
    new_functions_covered: uncovered.length,
    estimated_line_coverage_delta: `+${(uncovered.length * 2.5).toFixed(1)}%`,
  };
}

// ── Test framework detection ──

function detectTestFramework() {
  const cwd = process.cwd();

  // Check package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    if (allDeps.vitest) return "vitest";
    if (allDeps.jest) return "jest";
    if (allDeps.mocha) return "mocha";
    if (allDeps.tap) return "tap";
    if (allDeps.ava) return "ava";

    // Check scripts
    const scripts = pkg.scripts || {};
    const testScript = scripts.test || "";
    if (testScript.includes("vitest")) return "vitest";
    if (testScript.includes("jest")) return "jest";
    if (testScript.includes("mocha")) return "mocha";
    if (testScript.includes("tap")) return "tap";
    if (testScript.includes("ava")) return "ava";
    if (testScript.includes("node --test")) return "node:test";
  } catch {
    // no package.json
  }

  // Check config files
  const configFiles = {
    "vitest.config.ts": "vitest",
    "vitest.config.js": "vitest",
    "vitest.config.mjs": "vitest",
    "jest.config.js": "jest",
    "jest.config.ts": "jest",
    "jest.config.mjs": "jest",
    ".mocharc.yml": "mocha",
    ".mocharc.yaml": "mocha",
    ".mocharc.json": "mocha",
    ".mocharc.js": "mocha",
    "ava.config.js": "ava",
    "ava.config.mjs": "ava",
  };

  for (const [file, fw] of Object.entries(configFiles)) {
    if (fs.existsSync(path.join(cwd, file))) return fw;
  }

  return null;
}

function detectTestConfig(framework) {
  if (!framework) return null;
  const cwd = process.cwd();
  const candidates = {
    jest: ["jest.config.js", "jest.config.ts", "jest.config.mjs"],
    vitest: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
    mocha: [".mocharc.yml", ".mocharc.yaml", ".mocharc.json", ".mocharc.js"],
    tap: [".taprc"],
    ava: ["ava.config.js", "ava.config.mjs"],
  };

  for (const file of candidates[framework] || []) {
    if (fs.existsSync(path.join(cwd, file))) return file;
  }
  return null;
}

// ── Human-readable rendering ──

function renderHuman(result) {
  const { c } = out;

  const candidateCount = result.summary.total_candidates
    || result.summary.candidates_returned
    || result.candidates.length;

  out.heading("Test Candidates");
  out.info(`${candidateCount} candidate(s)`);

  out.blank();
  out.divider();

  if (result.candidates.length === 0) {
    out.blank();
    out.success("No test candidates — either no errors or full coverage.");
    out.blank();
    return;
  }

  for (const cand of result.candidates) {
    out.blank();

    // Header line: value badge + candidate ID + description
    const valueColor =
      cand.value === "critical" ? c.bgRed + c.white + c.bold :
      cand.value === "high" ? c.red + c.bold :
      cand.value === "medium" ? c.yellow :
      c.dim;

    out.line(
      `  ${valueColor}${cand.value.toUpperCase().padEnd(8)}${c.reset} ` +
      `${c.bold}${cand.candidate_id}${c.reset}  ` +
      `${c.dim}score: ${cand.score}${c.reset}`
    );

    // Description: v2 format uses error.class + error.message, old format uses reproduces.description
    const description = cand.error
      ? `${cand.error.class}: ${cand.error.message}`
      : cand.reproduces
        ? cand.reproduces.description
        : "Unknown error";
    out.line(`  ${description}`);

    // Trigger: v2 uses error.function / error.file, old uses trigger.function / trigger.file
    const triggerFn = cand.error?.function || cand.trigger?.function || null;
    const triggerFile = cand.error?.file || cand.trigger?.file || null;
    if (triggerFn) {
      out.line(
        `  ${c.dim}Trigger:${c.reset} ${c.cyan}${triggerFn}${c.reset}` +
        (triggerFile ? ` ${c.dim}at${c.reset} ${triggerFile}` : "")
      );
    }

    // Shape diff (v2 format)
    if (cand.reproduction?.shape_diff) {
      const diff = cand.reproduction.shape_diff;
      const diffColor = diff.status === "differs" ? c.green : c.dim;
      out.line(`  ${c.dim}Shape diff:${c.reset} ${diffColor}${diff.summary.slice(0, 100)}${c.reset}`);
    }

    // Coverage gap (old format — only if present)
    if (cand.existing_coverage) {
      out.line(
        `  ${c.dim}Coverage:${c.reset} ${
          cand.existing_coverage.covered
            ? `${c.yellow}Covered but error persists${c.reset}`
            : `${c.red}NOT COVERED${c.reset}`
        } ${c.dim}(${cand.existing_coverage.line_coverage_pct}%)${c.reset}`
      );
    }

    // Frequency + trend
    const freq = cand.frequency || {};
    const freqTotal = freq.total || 0;
    const freqRecent = freq.last_hour != null ? `${freq.last_hour} last hr` : freq.last_24h != null ? `${freq.last_24h} last 24h` : null;
    const trend = freq.trend || "stable";
    out.line(
      `  ${c.dim}Frequency:${c.reset} ${freqTotal} total` +
      (freqRecent ? ` (${freqRecent})` : "") +
      ` ${out.trendIcon(trend)} ${trend}`
    );

    // Grouped note (v2 format)
    if (cand.grouped_note) {
      out.line(`  ${c.dim}Note:${c.reset} ${cand.grouped_note}`);
    }

    // Suggested test file (old format — only if present)
    if (cand.suggested_test && cand.suggested_test.test_file) {
      out.line(`  ${c.dim}Test file:${c.reset} ${c.green}${cand.suggested_test.test_file}${c.reset}`);
    }

    // Fix hint (old format — only if present)
    if (cand.fix_hint) {
      out.line(`  ${c.dim}Hint:${c.reset} ${cand.fix_hint.slice(0, 120)}`);
    }

    out.divider();
  }

  // Summary
  out.blank();
  const byVal = result.summary.by_value || countByValue(result.candidates);
  out.line(
    `  ${c.bold}Summary:${c.reset} ` +
    `${c.red}${byVal.critical} critical${c.reset}  ` +
    `${c.yellow}${byVal.high} high${c.reset}  ` +
    `${byVal.medium} medium  ${byVal.low} low`
  );

  // Estimated coverage gain (only for old normalized format that has existing_coverage)
  if (result.candidates[0]?.existing_coverage) {
    const gain = estimateCoverageGain(result.candidates);
    out.line(
      `  ${c.dim}Estimated coverage gain:${c.reset} ` +
      `${gain.new_functions_covered} functions, ` +
      `${gain.estimated_line_coverage_delta}`
    );
  }
  out.blank();
}

module.exports = { execute };
