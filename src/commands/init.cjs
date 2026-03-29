"use strict";

/**
 * depct init — Project initialization
 *
 * Detects project, creates .depctrc, validates loader, runs smoke test.
 *
 * Usage:
 *   npx depct init
 *   depct init --local
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { ApiClient, writeConfig } = require("../api-client.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct init${out.c.reset} ${out.c.dim}— Initialize depct in a project${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct init [options]

${out.c.bold}Options${out.c.reset}
  --local                Use local SQLite mode (no server)
  --server-url <url>     Server URL (default: http://localhost:3007)
  --project <id>         Project ID
  --json                 JSON output for AI agents

${out.c.bold}What it does${out.c.reset}
  1. Detects project type and entry point
  2. Creates .depctrc configuration file
  3. Creates .depct/ directory for local data
  4. Validates loader availability
  5. Runs connectivity check
`;

async function execute(ctx) {
  if (ctx.flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const cwd = process.cwd();
  const steps = [];

  if (!ctx.json) {
    out.heading("Initializing depct");
    out.blank();
  }

  // Step 1: Detect project
  const project = detectProject(cwd);
  steps.push({
    step: "detect_project",
    status: "ok",
    details: project,
  });

  if (!ctx.json) {
    out.success(`Detected: ${project.type} project`);
    if (project.name) out.label("Name", project.name);
    if (project.entry) out.label("Entry", project.entry);
    if (project.framework) out.label("Framework", project.framework);
  }

  // Step 2: Create .depctrc
  const rcPath = path.join(cwd, ".depctrc");
  const rcExists = fs.existsSync(rcPath);
  const rcData = {
    projectId: ctx.flags.project || project.name || path.basename(cwd),
    serverUrl: ctx.flags.serverUrl || "http://localhost:3007",
    local: !!ctx.flags.local,
  };

  if (!rcExists) {
    writeConfig(rcPath, rcData);
    steps.push({ step: "create_depctrc", status: "ok", path: rcPath });
    if (!ctx.json) out.success(`Created ${out.c.cyan}.depctrc${out.c.reset}`);
  } else {
    steps.push({ step: "create_depctrc", status: "skipped", reason: "already exists" });
    if (!ctx.json) out.info(".depctrc already exists, skipping");
  }

  // Step 3: Create .depct/ directory
  const depctDir = path.join(cwd, ".depct");
  if (!fs.existsSync(depctDir)) {
    fs.mkdirSync(depctDir, { recursive: true });
    steps.push({ step: "create_depct_dir", status: "ok", path: depctDir });
    if (!ctx.json) out.success(`Created ${out.c.cyan}.depct/${out.c.reset} directory`);
  } else {
    steps.push({ step: "create_depct_dir", status: "skipped", reason: "already exists" });
    if (!ctx.json) out.info(".depct/ directory already exists");
  }

  // Step 4: Add .depct to .gitignore
  const gitignorePath = path.join(cwd, ".gitignore");
  let gitignoreUpdated = false;
  try {
    let gitignore = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, "utf8")
      : "";
    if (!gitignore.includes(".depct/")) {
      gitignore += "\n# depct local data\n.depct/\n";
      fs.writeFileSync(gitignorePath, gitignore, "utf8");
      gitignoreUpdated = true;
    }
  } catch {
    // Not a critical failure
  }

  steps.push({
    step: "update_gitignore",
    status: gitignoreUpdated ? "ok" : "skipped",
  });
  if (!ctx.json && gitignoreUpdated) {
    out.success(`Added ${out.c.cyan}.depct/${out.c.reset} to .gitignore`);
  }

  // Step 5: Validate loader
  const loader = validateLoader();
  steps.push({
    step: "validate_loader",
    status: loader.available ? "ok" : "warning",
    details: loader,
  });

  if (!ctx.json) {
    if (loader.available) {
      out.success(`Loader available${loader.version ? ` (v${loader.version})` : ""}`);
    } else {
      out.warn("Loader not found. Install depct-loader or run from monorepo.");
    }
  }

  // Step 6: Connectivity check
  let connectivity = { ok: false };
  try {
    const client = new ApiClient({
      serverUrl: ctx.flags.serverUrl,
      local: ctx.flags.local,
    });
    connectivity = await client.ping();
  } catch {
    connectivity = { ok: false, error: "Could not connect" };
  }

  steps.push({
    step: "connectivity_check",
    status: connectivity.ok ? "ok" : "warning",
    details: connectivity,
  });

  if (!ctx.json) {
    if (connectivity.ok) {
      out.success(`Server reachable (${connectivity.mode || "unknown"} mode)`);
    } else {
      out.warn(
        `Server not reachable${ctx.flags.local ? " (local mode — will work when loader writes data)" : ". Start the server or use --local mode."}`
      );
    }
  }

  // Result
  const allOk = steps.every((s) => s.status === "ok" || s.status === "skipped");

  if (ctx.json) {
    out.json({
      initialized: true,
      project: rcData,
      steps,
      next_steps: [
        !loader.available ? "Install depct-loader: npm install depct-loader" : null,
        `Run your app: depct start${ctx.flags.local ? " --local" : ""} node server.js`,
        "Check status: depct status",
      ].filter(Boolean),
      _meta: {
        command: "init",
        timestamp: new Date().toISOString(),
      },
    });
    return;
  }

  out.blank();
  out.divider();
  out.blank();

  if (allOk) {
    out.success(`${out.c.bold}depct initialized.${out.c.reset}`);
  } else {
    out.warn(`${out.c.bold}depct initialized with warnings.${out.c.reset}`);
  }

  out.blank();
  out.subheading("Next steps");
  if (!loader.available) {
    out.indent(`${out.c.cyan}npm install depct-loader${out.c.reset}`);
  }
  out.indent(
    `${out.c.cyan}depct start${ctx.flags.local ? " --local" : ""} node server.js${out.c.reset}`
  );
  out.indent(`${out.c.cyan}depct status${out.c.reset}`);
  out.blank();
}

function detectProject(cwd) {
  const result = {
    type: "unknown",
    name: null,
    entry: null,
    framework: null,
    test_framework: null,
  };

  // Read package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    result.type = "node";
    result.name = pkg.name || null;
    result.entry = pkg.main || null;

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Detect framework
    if (allDeps.next) result.framework = "next";
    else if (allDeps.express) result.framework = "express";
    else if (allDeps.fastify) result.framework = "fastify";
    else if (allDeps.koa) result.framework = "koa";
    else if (allDeps.hapi || allDeps["@hapi/hapi"]) result.framework = "hapi";
    else if (allDeps.nest || allDeps["@nestjs/core"]) result.framework = "nestjs";

    // Detect test framework
    if (allDeps.vitest) result.test_framework = "vitest";
    else if (allDeps.jest) result.test_framework = "jest";
    else if (allDeps.mocha) result.test_framework = "mocha";
    else if (allDeps.tap) result.test_framework = "tap";
    else if (allDeps.ava) result.test_framework = "ava";

    // Detect entry from scripts
    if (!result.entry && pkg.scripts) {
      const startScript = pkg.scripts.start || pkg.scripts.dev || "";
      const match = startScript.match(/node\s+(\S+)/);
      if (match) result.entry = match[1];
    }
  } catch {
    // Not a Node project or no package.json
  }

  return result;
}

function validateLoader() {
  // Try require.resolve
  try {
    const entry = require.resolve("depct-loader");
    let version = null;
    try {
      const pkg = require("depct-loader/package.json");
      version = pkg.version;
    } catch {}
    return { available: true, path: entry, version };
  } catch {}

  // Try monorepo sibling
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
