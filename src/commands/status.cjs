"use strict";

/**
 * depct status — System health check
 *
 * Usage:
 *   depct status --json
 */

const { ApiClient } = require("../api-client.cjs");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct status${out.c.reset} ${out.c.dim}— System health check${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct status [options]

${out.c.bold}Options${out.c.reset}
  --json                 JSON output for AI agents
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

  // Ping server
  const health = await client.ping();

  let projectStats = null;
  if (health.ok) {
    try {
      projectStats = await client.get("/api/status");
    } catch {
      // Server reachable but /api/status may not exist yet
    }
  }

  const result = {
    server: {
      reachable: health.ok,
      mode: health.mode || (client.isLocal ? "local" : "remote"),
      url: client.isLocal ? null : client.serverUrl,
      db_path: health.dbPath || null,
      error: health.error || null,
    },
    loader: detectLoader(),
    project: projectStats
      ? {
          id: projectStats.project_id || projectStats.projectId || null,
          name: projectStats.project_name || projectStats.name || null,
          functions_tracked: projectStats.functions_tracked || projectStats.functionsTracked || 0,
          error_groups: projectStats.error_groups || projectStats.errorGroups || 0,
          traces_today: projectStats.traces_today || projectStats.tracesToday || 0,
          last_event: projectStats.last_event || projectStats.lastEvent || null,
        }
      : null,
    _meta: {
      command: "status",
      timestamp: new Date().toISOString(),
      cli_version: "2.0.0",
    },
  };

  if (ctx.json) {
    out.json(result);
    return;
  }

  renderHuman(result);
}

function detectLoader() {
  const fs = require("node:fs");
  const path = require("node:path");

  let installed = false;
  let version = null;
  let loaderPath = null;

  // Check if loader is resolvable
  try {
    loaderPath = require.resolve("depct-loader");
    installed = true;
    try {
      const pkg = require("depct-loader/package.json");
      version = pkg.version;
    } catch {
      version = "unknown";
    }
  } catch {
    // Try monorepo sibling
    const sibling = path.resolve(__dirname, "../../../loader/src/index.cjs");
    if (fs.existsSync(sibling)) {
      installed = true;
      loaderPath = sibling;
      try {
        const pkg = JSON.parse(
          fs.readFileSync(
            path.resolve(__dirname, "../../../loader/package.json"),
            "utf8"
          )
        );
        version = pkg.version;
      } catch {
        version = "unknown";
      }
    }
  }

  // Check if NODE_OPTIONS includes loader
  const nodeOpts = process.env.NODE_OPTIONS || "";
  const active = nodeOpts.includes("depct-loader") || nodeOpts.includes("depct");

  return {
    installed,
    active,
    version,
    path: loaderPath,
  };
}

function renderHuman(result) {
  const { c } = out;

  out.heading("depct status");
  out.blank();

  // Server
  out.subheading("Server");
  if (result.server.reachable) {
    out.success(
      `${result.server.mode === "local" ? "Local" : "Remote"} server reachable` +
      (result.server.url ? ` at ${c.cyan}${result.server.url}${c.reset}` : "") +
      (result.server.db_path ? ` ${c.dim}(${result.server.db_path})${c.reset}` : "")
    );
  } else {
    out.error(
      `Server not reachable${result.server.error ? `: ${result.server.error}` : ""}`
    );
  }

  // Loader
  out.blank();
  out.subheading("Loader");
  if (result.loader.installed) {
    out.success(
      `Installed${result.loader.version ? ` v${result.loader.version}` : ""}`
    );
    if (result.loader.active) {
      out.success("Active (NODE_OPTIONS configured)");
    } else {
      out.warn("Not active — run 'depct start <cmd>' to instrument");
    }
  } else {
    out.error("Not installed");
  }

  // Project
  out.blank();
  out.subheading("Project");
  if (result.project) {
    out.label("ID", result.project.id || "unknown");
    out.label("Functions", String(result.project.functions_tracked));
    out.label("Error Groups", String(result.project.error_groups));
    out.label("Traces Today", String(result.project.traces_today));
    if (result.project.last_event) {
      out.label("Last Event", out.formatAge(result.project.last_event));
    }
  } else {
    out.info("No project data available.");
  }

  out.blank();
}

module.exports = { execute };
