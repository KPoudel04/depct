"use strict";

/**
 * depct doctor — Diagnose setup issues
 *
 * Checks everything needed for depct to work:
 * Node version, loader, server, config, project structure.
 *
 * Usage:
 *   depct doctor
 *   depct doctor --json
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { ApiClient, findProjectRc } = require("../api-client.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct doctor${out.c.reset} ${out.c.dim}— Diagnose setup issues${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct doctor [options]

${out.c.bold}Options${out.c.reset}
  --json                 JSON output for AI agents
  --fix                  Attempt to fix found issues

${out.c.bold}Checks${out.c.reset}
  - Node.js version (>=20 required)
  - depct-loader availability
  - Server connectivity
  - Project configuration (.depctrc)
  - .depct/ directory
  - git repository status
`;

async function execute(ctx) {
  if (ctx.flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const checks = [];

  if (!ctx.json) {
    out.heading("depct doctor");
    out.blank();
  }

  // Check 1: Node version
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split(".")[0], 10);
  checks.push({
    name: "node_version",
    status: nodeMajor >= 20 ? "ok" : "error",
    message: `Node.js v${nodeVersion}`,
    detail: nodeMajor >= 20 ? "v20+ required" : `v20+ required, found v${nodeVersion}`,
    fix: nodeMajor < 20 ? "Upgrade Node.js to v20 or later" : null,
  });

  // Check 2: Loader
  const loader = checkLoader();
  checks.push({
    name: "loader",
    status: loader.available ? "ok" : "warning",
    message: loader.available
      ? `Loader found${loader.version ? ` v${loader.version}` : ""}`
      : "Loader not found",
    detail: loader.path || null,
    fix: !loader.available ? "npm install depct-loader" : null,
  });

  // Check 3: Project config
  const rcPath = findProjectRc(process.cwd());
  checks.push({
    name: "project_config",
    status: rcPath ? "ok" : "warning",
    message: rcPath ? `.depctrc found` : "No .depctrc found",
    detail: rcPath || null,
    fix: !rcPath ? "Run 'depct init' to create configuration" : null,
  });

  // Check 4: .depct directory
  const depctDir = path.join(process.cwd(), ".depct");
  const depctDirExists = fs.existsSync(depctDir);
  checks.push({
    name: "data_directory",
    status: depctDirExists ? "ok" : "info",
    message: depctDirExists ? ".depct/ directory exists" : ".depct/ directory not found",
    detail: depctDirExists ? depctDir : null,
    fix: !depctDirExists ? "Run 'depct init' to create it" : null,
  });

  // Check 5: SQLite database (local mode)
  const dbPath = path.join(depctDir, "depct.db");
  const dbExists = fs.existsSync(dbPath);
  checks.push({
    name: "local_database",
    status: dbExists ? "ok" : "info",
    message: dbExists ? "Local database exists" : "No local database (will be created on first run)",
    detail: dbExists ? dbPath : null,
    fix: null,
  });

  // Check 6: Server connectivity
  let serverCheck;
  try {
    const client = new ApiClient({
      serverUrl: ctx.flags.serverUrl,
      local: ctx.flags.local,
    });
    const health = await client.ping();
    serverCheck = {
      name: "server",
      status: health.ok ? "ok" : "warning",
      message: health.ok
        ? `Server reachable (${health.mode || "unknown"} mode)`
        : `Server not reachable${health.error ? `: ${health.error}` : ""}`,
      detail: health,
      fix: !health.ok ? "Start the server or use --local mode" : null,
    };
  } catch (err) {
    serverCheck = {
      name: "server",
      status: "warning",
      message: `Server check failed: ${err.message}`,
      detail: null,
      fix: "Start the depct server or use --local mode",
    };
  }
  checks.push(serverCheck);

  // Check 7: Git
  let gitCheck;
  try {
    const gitVersion = execSync("git --version", { encoding: "utf8", timeout: 5000 }).trim();
    const inRepo = (() => {
      try {
        execSync("git rev-parse --git-dir", { encoding: "utf8", timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    })();

    gitCheck = {
      name: "git",
      status: "ok",
      message: `${gitVersion}${inRepo ? " (in a repo)" : " (not in a repo)"}`,
      detail: { version: gitVersion, in_repo: inRepo },
      fix: null,
    };
  } catch {
    gitCheck = {
      name: "git",
      status: "info",
      message: "Git not found (optional — needed for validate/resolve commands)",
      detail: null,
      fix: null,
    };
  }
  checks.push(gitCheck);

  // Check 8: package.json
  const pkgPath = path.join(process.cwd(), "package.json");
  checks.push({
    name: "package_json",
    status: fs.existsSync(pkgPath) ? "ok" : "warning",
    message: fs.existsSync(pkgPath) ? "package.json found" : "No package.json",
    detail: fs.existsSync(pkgPath) ? pkgPath : null,
    fix: !fs.existsSync(pkgPath) ? "Run from a Node.js project directory" : null,
  });

  // Auto-fix if --fix
  if (ctx.flags.fix) {
    for (const check of checks) {
      if (check.status !== "ok" && check.fix) {
        if (check.name === "project_config" || check.name === "data_directory") {
          // Run init
          const initCmd = require("./init.cjs");
          await initCmd.execute({ ...ctx, flags: { ...ctx.flags, help: false } });
          check.status = "fixed";
          check.message += " (fixed)";
          break; // init handles both
        }
      }
    }
  }

  // Summary
  const errors = checks.filter((c) => c.status === "error");
  const warnings = checks.filter((c) => c.status === "warning");
  const ok = checks.filter((c) => c.status === "ok");

  const result = {
    healthy: errors.length === 0,
    checks,
    summary: {
      ok: ok.length,
      warnings: warnings.length,
      errors: errors.length,
      total: checks.length,
    },
    _meta: {
      command: "doctor",
      timestamp: new Date().toISOString(),
      cli_version: "2.0.0",
      node_version: nodeVersion,
    },
  };

  if (ctx.json) {
    out.json(result);
    return;
  }

  // Render human-readable
  for (const check of checks) {
    const icon =
      check.status === "ok" ? `${out.c.green}\u2713${out.c.reset}` :
      check.status === "error" ? `${out.c.red}\u2717${out.c.reset}` :
      check.status === "warning" ? `${out.c.yellow}\u26a0${out.c.reset}` :
      check.status === "fixed" ? `${out.c.green}\u2713${out.c.reset}` :
      `${out.c.dim}\u2022${out.c.reset}`;

    out.line(`  ${icon} ${check.message}`);
    if (check.fix && check.status !== "fixed") {
      out.line(`    ${out.c.dim}fix: ${check.fix}${out.c.reset}`);
    }
  }

  out.blank();
  out.divider();
  out.blank();

  if (errors.length === 0 && warnings.length === 0) {
    out.success(`${out.c.bold}All checks passed.${out.c.reset} depct is ready.`);
  } else if (errors.length === 0) {
    out.warn(
      `${out.c.bold}${warnings.length} warning(s).${out.c.reset} ` +
      "depct will work but some features may be limited."
    );
  } else {
    out.error(
      `${out.c.bold}${errors.length} error(s).${out.c.reset} ` +
      "Fix the errors above before using depct."
    );
  }

  out.blank();
}

function checkLoader() {
  try {
    const entry = require.resolve("depct-loader");
    let version = null;
    try {
      version = require("depct-loader/package.json").version;
    } catch {}
    return { available: true, path: entry, version };
  } catch {}

  const sibling = path.resolve(__dirname, "../../../loader/src/index.cjs");
  if (fs.existsSync(sibling)) {
    let version = null;
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "../../../loader/package.json"), "utf8")
      );
      version = pkg.version;
    } catch {}
    return { available: true, path: sibling, version };
  }

  return { available: false, path: null, version: null };
}

module.exports = { execute };
