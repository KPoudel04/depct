"use strict";

/**
 * depct CLI framework
 *
 * Parses global flags, resolves subcommand, dispatches.
 * Zero external dependencies.
 */

const path = require("node:path");
const { parseArgs } = require("./parse-args.cjs");
const { c } = require("./output.cjs");

const VERSION = "2.0.0";

const COMMANDS = {
  errors: { file: "errors.cjs", desc: "What's broken? Error groups with evidence." },
  trace: { file: "trace.cjs", desc: "Execution traces for an endpoint or function." },
  inspect: { file: "inspect.cjs", desc: "Deep dive on a function." },
  "build-test": { file: "build-test.cjs", desc: "Test candidates from error evidence." },
  anomalies: { file: "anomalies.cjs", desc: "Detect behavioral anomalies vs baselines." },
  deps: { file: "deps.cjs", desc: "External dependencies and their health." },
  status: { file: "status.cjs", desc: "System health and project stats." },
  start: { file: "start.cjs", desc: "Instrument and run your app." },
  init: { file: "init.cjs", desc: "Initialize depct in a project." },
  doctor: { file: "doctor.cjs", desc: "Diagnose setup issues." },
};

function printHelp() {
  const lines = [
    "",
    `${c.bold}depct${c.reset} ${c.dim}v${VERSION}${c.reset} ${c.dim}\u2014 state layer for AI agents${c.reset}`,
    "",
    `${c.bold}Usage${c.reset}`,
    `  ${c.cyan}depct${c.reset} <command> [options]`,
    "",
    `${c.bold}Commands${c.reset}`,
  ];

  const categories = {
    "Intelligence": ["errors", "trace", "inspect", "build-test", "anomalies", "deps"],
    "System": ["status", "start", "init", "doctor"],
  };

  for (const [cat, cmds] of Object.entries(categories)) {
    lines.push(`  ${c.dim}${cat}${c.reset}`);
    for (const name of cmds) {
      const cmd = COMMANDS[name];
      lines.push(`    ${c.cyan}${name.padEnd(16)}${c.reset}${c.dim}${cmd.desc}${c.reset}`);
    }
    lines.push("");
  }

  lines.push(`${c.bold}Flags${c.reset}`);
  lines.push(`  ${c.cyan}--json${c.reset}              Machine-readable JSON output`);
  lines.push(`  ${c.cyan}-h, --help${c.reset}           Show help`);
  lines.push(`  ${c.cyan}-v, --version${c.reset}        Show version`);
  lines.push("");
  lines.push(`${c.bold}Quick Start${c.reset}`);
  lines.push(`  ${c.cyan}depct start -- node server.js${c.reset}    Instrument and run`);
  lines.push(`  ${c.cyan}depct errors --json${c.reset}              See what's broken`);
  lines.push(`  ${c.cyan}depct build-test --json${c.reset}          Get test candidates`);
  lines.push("");
  lines.push(`${c.dim}Every command supports --json for AI agent consumption.${c.reset}`);
  lines.push("");

  process.stdout.write(lines.join("\n"));
}

async function run(argv) {
  const { flags, positional, rest } = parseArgs(argv);

  // Version
  if (flags.v || flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // No command or help
  const commandName = positional[0];
  if (!commandName || flags.h || flags.help) {
    // If help is for a specific command, defer to command
    if (commandName && COMMANDS[commandName]) {
      // Pass --help to the command
      flags.help = true;
    } else {
      printHelp();
      return;
    }
  }

  // Resolve command
  const cmdDef = COMMANDS[commandName];
  if (!cmdDef) {
    process.stderr.write(
      `${c.red}Unknown command:${c.reset} ${commandName}\n\n`
    );
    process.stderr.write(`Run ${c.cyan}depct --help${c.reset} to see available commands.\n`);
    process.exitCode = 1;
    return;
  }

  // Load and execute command
  const cmdModule = require(path.join(__dirname, "commands", cmdDef.file));

  // Build context
  const ctx = {
    flags,
    args: positional.slice(1),
    rest,
    json: !!flags.json,
    commandName,
  };

  await cmdModule.execute(ctx);
}

module.exports = { run, VERSION, COMMANDS };
