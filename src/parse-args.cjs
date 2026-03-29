"use strict";

/**
 * Minimal argument parser — zero dependencies.
 *
 * Supports:
 *   --flag            boolean true
 *   --key value       string value
 *   --key=value       string value
 *   --no-flag         boolean false
 *   positional args
 *   -- rest args
 */

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const rest = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    // Everything after -- is rest args
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    // Long flag with =
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(2, eq);
      const val = arg.slice(eq + 1);
      flags[camelCase(key)] = val;
      i++;
      continue;
    }

    // Long flag
    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      // --no-* pattern
      if (key.startsWith("no-") && key.length > 3) {
        flags[camelCase(key.slice(3))] = false;
        i++;
        continue;
      }

      // Check if next arg is a value (not a flag)
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[camelCase(key)] = next;
        i += 2;
        continue;
      }

      flags[camelCase(key)] = true;
      i++;
      continue;
    }

    // Short flag: -h, -v
    if (arg.startsWith("-") && arg.length === 2) {
      const key = arg[1];
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
        continue;
      }
      flags[key] = true;
      i++;
      continue;
    }

    // Positional
    positional.push(arg);
    i++;
  }

  return { flags, positional, rest };
}

function camelCase(str) {
  return str.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Parse a "since" duration string into a Date.
 * Supports: 30s, 5m, 2h, 1d, 7d, 2w
 */
function parseSince(since) {
  if (!since) return null;

  // If it looks like an ISO date, return as-is
  if (since.includes("T") || since.includes("-")) {
    return new Date(since);
  }

  const match = since.match(/^(\d+)([smhdw])$/);
  if (!match) {
    throw new Error(
      `Invalid --since value: "${since}". Use e.g. 30s, 5m, 2h, 1d, 2w`
    );
  }

  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return new Date(Date.now() - num * multipliers[unit]);
}

module.exports = { parseArgs, parseSince };
