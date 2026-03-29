"use strict";

/**
 * depct start — Instrument and run app
 *
 * Wraps the target app with the depct loader via NODE_OPTIONS.
 * In --local mode, also starts the embedded server.
 *
 * Usage:
 *   depct start node server.js
 *   depct start --local node server.js
 *   depct start -- npm run dev
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const out = require("../output.cjs");

const HELP = `
${out.c.bold}depct start${out.c.reset} ${out.c.dim}— Instrument and run your app${out.c.reset}

${out.c.bold}Usage${out.c.reset}
  depct start [options] <command> [args...]
  depct start [options] -- <command> [args...]

${out.c.bold}Options${out.c.reset}
  --local                Local mode (embedded server + SQLite)
  --debug                Enable loader debug output
  --server-url <url>     Server URL override
  --no-traffic           Disable synthetic traffic generation
  --json                 JSON output for AI agents

${out.c.bold}Examples${out.c.reset}
  ${out.c.cyan}depct start node server.js${out.c.reset}
  ${out.c.cyan}depct start --local node server.js${out.c.reset}
  ${out.c.cyan}depct start -- npm run dev${out.c.reset}
`;

async function execute(ctx) {
  if (ctx.flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  // Command to run is either in rest args (after --) or in args
  let childCmd, childArgs;
  if (ctx.rest.length > 0) {
    childCmd = ctx.rest[0];
    childArgs = ctx.rest.slice(1);
  } else if (ctx.args.length > 0) {
    childCmd = ctx.args[0];
    childArgs = ctx.args.slice(1);
  } else {
    out.error("Missing command. Usage: depct start <command>");
    out.info("Example: depct start node server.js");
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();

  // ── Auto-detect local mode ──
  // If no .depctrc exists AND no --server-url was passed, default to local mode.
  // Users who explicitly pass --local or --server-url keep full control.
  const rcPath = path.join(cwd, ".depctrc");
  const rcExists = fs.existsSync(rcPath);
  let useLocal = !!ctx.flags.local;

  if (!useLocal && !ctx.flags.serverUrl) {
    if (rcExists) {
      // Read the rc file — if it says local: true, honour it
      try {
        const rc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
        if (rc.local) useLocal = true;
      } catch {
        // Malformed rc — fall through to auto-detect
      }
    } else {
      // No rc, no --server-url → auto-local
      useLocal = true;
    }
  }

  // ── Auto-init ──
  // Create .depct/ directory and .depctrc if they don't exist (silent, like init).
  const depctDir = path.join(cwd, ".depct");
  if (!fs.existsSync(depctDir)) {
    fs.mkdirSync(depctDir, { recursive: true });
  }

  if (!rcExists && useLocal) {
    // Derive project name from package.json or directory name
    let projectName = path.basename(cwd);
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(cwd, "package.json"), "utf8")
      );
      if (pkg.name) projectName = pkg.name;
    } catch {
      // No package.json — directory name is fine
    }

    const rcData = { local: true, projectId: projectName };
    fs.writeFileSync(rcPath, JSON.stringify(rcData, null, 2) + "\n", "utf8");

    // Add .depct/ to .gitignore if not already there
    try {
      const gitignorePath = path.join(cwd, ".gitignore");
      let gitignore = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, "utf8")
        : "";
      if (!gitignore.includes(".depct/")) {
        gitignore += "\n# depct local data\n.depct/\n";
        fs.writeFileSync(gitignorePath, gitignore, "utf8");
      }
    } catch {
      // Not critical
    }

    // Inject depct commands into AI agent config files so they use it automatically
    injectAIConfig(cwd);
  }

  // Resolve loader
  const loaderEntry = resolveLoaderEntry();
  if (!loaderEntry) {
    out.error(
      "Loader not found. Install depct-loader or run from the monorepo."
    );
    process.exitCode = 1;
    return;
  }

  // Build NODE_OPTIONS — both --require (CJS) and --import (ESM)
  const existingNodeOpts = process.env.NODE_OPTIONS || "";
  const requireFlag = `--require ${quoteIfNeeded(loaderEntry)}`;

  // ESM register hook lives next to the CJS loader
  const esmRegister = path.resolve(path.dirname(loaderEntry), "register.mjs");
  const hasEsmHook = fs.existsSync(esmRegister);
  const importFlag = hasEsmHook ? `--import ${quoteIfNeeded(esmRegister)}` : "";

  const depctFlags = [requireFlag, importFlag].filter(Boolean).join(" ");
  const nodeOptions = existingNodeOpts
    ? `${existingNodeOpts} ${depctFlags}`
    : depctFlags;

  // Build environment
  const env = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    DEPCT_ACTIVE: "1",
  };

  if (ctx.flags.serverUrl) {
    env.DEPCT_SERVER_URL = ctx.flags.serverUrl;
  }

  // Set project ID so loader and CLI agree
  let projectName;
  try {
    const rcContent = fs.existsSync(rcPath) ? JSON.parse(fs.readFileSync(rcPath, "utf8")) : {};
    projectName = rcContent.projectId || rcContent.project_id;
  } catch { /* */ }
  if (!projectName) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      projectName = pkg.name;
    } catch { /* */ }
  }
  if (!projectName) projectName = path.basename(cwd);
  env.DEPCT_PROJECT_ID = projectName;

  if (useLocal) {
    env.DEPCT_LOCAL = "1";
    env.DEPCT_DB_PATH = path.join(cwd, ".depct", "depct.db");
  }

  if (ctx.flags.debug) {
    env.DEPCT_DEBUG = "1";
  }

  const mode = useLocal ? "local" : "remote";

  // JSON output: emit start event then run
  if (ctx.json) {
    out.json({
      event: "start",
      command: childCmd,
      args: childArgs,
      loader: loaderEntry,
      mode,
      node_options: nodeOptions,
      _meta: {
        command: "start",
        timestamp: new Date().toISOString(),
      },
    });
  } else {
    const { c } = out;
    out.heading("depct start");
    out.label("Command", `${childCmd} ${childArgs.join(" ")}`);
    out.label("Loader", loaderEntry);
    out.label("Mode", mode);
    if (ctx.flags.debug) out.label("Debug", "enabled");
    out.blank();
    out.divider();
    out.blank();
    if (useLocal) {
      out.info("depct is watching. Errors captured to .depct/depct.db");
      out.info("Query with: depct errors");
      out.blank();
    }
  }

  // Start local server if needed
  if (useLocal) {
    await startLocalServer(env);
  }

  // Spawn the child process
  const child = spawn(childCmd, childArgs, {
    env,
    stdio: "inherit",
    shell: true,
  });

  child.on("error", (err) => {
    out.error(`Failed to start: ${err.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (ctx.json) {
      out.ndjson({
        event: "exit",
        code,
        signal,
        timestamp: new Date().toISOString(),
      });
    }
    process.exitCode = code ?? 1;
  });

  // Forward signals
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
}

async function startLocalServer(env) {
  // Try to start embedded server
  try {
    const serverPkg = resolveServerPackage();
    if (serverPkg) {
      const server = require(path.join(serverPkg, "src/index.cjs"));
      if (typeof server.startEmbedded === "function") {
        await server.startEmbedded({
          dbPath: env.DEPCT_DB_PATH,
          port: 0, // Let OS assign port
        });
        return;
      }
    }
  } catch {
    // Server not available or can't start embedded
    // In local mode this is fine — loader writes directly to SQLite
  }
}

function resolveLoaderEntry() {
  // 1. Bundled loader (single-package publish)
  const bundled = path.resolve(__dirname, "../../loader/index.cjs");
  if (fs.existsSync(bundled)) return bundled;

  // 2. Separate depct-loader package
  try {
    return require.resolve("depct-loader");
  } catch {}

  // 3. Monorepo sibling (development)
  const sibling = path.resolve(__dirname, "../../../loader/src/index.cjs");
  if (fs.existsSync(sibling)) return sibling;

  return null;
}

function quoteIfNeeded(str) {
  if (str.includes(" ")) return `"${str}"`;
  return str;
}

// ── AI agent config injection ──
// Appends depct commands to CLAUDE.md and .cursorrules so AI agents
// discover and use runtime intelligence automatically.

const DEPCT_SECTION_MARKER = "<!-- depct:start -->";
const DEPCT_SECTION_END = "<!-- depct:end -->";

const DEPCT_AI_INSTRUCTIONS = `${DEPCT_SECTION_MARKER}
## Runtime Intelligence (depct)

This project is instrumented with depct. When debugging errors, investigating
performance issues, or writing tests, **query runtime data before reading source code**:

\`\`\`bash
depct errors --json          # Error groups with causal chains and arg shape diffs
depct build-test --json      # Test candidates ranked by shape diff quality
depct trace <endpoint> --json  # Execution trace with timing at every hop
depct inspect <function> --json  # Deep dive on a specific function
depct status --json          # System health overview
\`\`\`

Shape diffs show exactly how argument values differ between failing and succeeding
calls — use these to write targeted fixes and tests. Output is structured JSON
designed for AI consumption.
${DEPCT_SECTION_END}`;

function injectAIConfig(cwd) {
  // CLAUDE.md
  try {
    injectIntoFile(path.join(cwd, "CLAUDE.md"));
  } catch { /* not critical */ }

  // .cursorrules
  try {
    injectIntoFile(path.join(cwd, ".cursorrules"));
  } catch { /* not critical */ }
}

function injectIntoFile(filePath) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
    // Already injected — skip
    if (content.includes(DEPCT_SECTION_MARKER)) return;
  }
  // Append with a blank line separator
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n\n" : content.length > 0 ? "\n" : "";
  fs.writeFileSync(filePath, content + separator + DEPCT_AI_INSTRUCTIONS + "\n", "utf8");
}

module.exports = { execute };
