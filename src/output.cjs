"use strict";

/**
 * Dual-mode output system for depct CLI
 *
 * With --json  : clean JSON to stdout (machine-consumable)
 * Without --json: human-readable ANSI-colored terminal output
 *
 * Zero external dependencies.
 */

// ── ANSI color helpers ──

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const c = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  italic: useColor ? "\x1b[3m" : "",
  underline: useColor ? "\x1b[4m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  blue: useColor ? "\x1b[34m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  white: useColor ? "\x1b[37m" : "",
  bgRed: useColor ? "\x1b[41m" : "",
  bgGreen: useColor ? "\x1b[42m" : "",
  bgYellow: useColor ? "\x1b[43m" : "",
  bgBlue: useColor ? "\x1b[44m" : "",
};

// ── Severity colors ──

function severityColor(severity) {
  switch (severity) {
    case "critical":
      return c.bgRed + c.white + c.bold;
    case "high":
      return c.red + c.bold;
    case "medium":
      return c.yellow;
    case "low":
      return c.dim;
    default:
      return c.reset;
  }
}

function trendIcon(trend) {
  if (trend === "rising") return `${c.red}^${c.reset}`;
  if (trend === "falling") return `${c.green}v${c.reset}`;
  if (trend === "stable") return `${c.dim}-${c.reset}`;
  return `${c.dim}?${c.reset}`;
}

// ── Spinner ──

function spinner(message) {
  if (!process.stdout.isTTY) {
    process.stderr.write(`${message}\n`);
    return {
      stop(final) {
        if (final) process.stderr.write(`${final}\n`);
      },
      update(msg) {
        process.stderr.write(`${msg}\n`);
      },
    };
  }
  const frames = ["\u2802", "\u2812", "\u2832", "\u2834", "\u2826", "\u2816", "\u2812", "\u2810"];
  let i = 0;
  const id = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stderr.write(
      `\r${c.cyan}${frames[i]}${c.reset} ${c.dim}${message}${c.reset}  `
    );
  }, 100);
  return {
    stop(final) {
      clearInterval(id);
      process.stderr.write(`\r\x1b[2K`);
      if (final) process.stderr.write(`${final}\n`);
    },
    update(msg) {
      message = msg;
    },
  };
}

// ── JSON output ──

function json(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function ndjson(data) {
  process.stdout.write(JSON.stringify(data) + "\n");
}

// ── Human-readable output ──

function heading(text) {
  process.stdout.write(`\n${c.bold}${c.cyan}${text}${c.reset}\n`);
}

function subheading(text) {
  process.stdout.write(`${c.bold}${text}${c.reset}\n`);
}

function info(text) {
  process.stdout.write(`${c.dim}${text}${c.reset}\n`);
}

function success(text) {
  process.stdout.write(`${c.green}\u2713${c.reset} ${text}\n`);
}

function warn(text) {
  process.stdout.write(`${c.yellow}\u26a0${c.reset} ${text}\n`);
}

function error(text) {
  process.stderr.write(`${c.red}\u2717${c.reset} ${text}\n`);
}

function line(text = "") {
  process.stdout.write(`${text}\n`);
}

function blank() {
  process.stdout.write("\n");
}

function indent(text, level = 1) {
  const pad = "  ".repeat(level);
  process.stdout.write(`${pad}${text}\n`);
}

function label(key, value) {
  process.stdout.write(`  ${c.dim}${key}:${c.reset} ${value}\n`);
}

function divider() {
  const width = process.stdout.columns || 80;
  process.stdout.write(`${c.dim}${"─".repeat(Math.min(width, 80))}${c.reset}\n`);
}

// ── Table formatter ──

function table(rows, columns) {
  if (!rows || rows.length === 0) return;

  // Calculate column widths
  const widths = {};
  for (const col of columns) {
    widths[col.key] = col.label ? col.label.length : col.key.length;
  }
  for (const row of rows) {
    for (const col of columns) {
      const val = String(row[col.key] ?? "");
      // Strip ANSI for width calculation
      const stripped = val.replace(/\x1b\[[0-9;]*m/g, "");
      widths[col.key] = Math.max(widths[col.key], stripped.length);
    }
  }

  // Header
  const headerLine = columns
    .map((col) => {
      const label = col.label || col.key;
      return label.toUpperCase().padEnd(widths[col.key]);
    })
    .join("  ");
  process.stdout.write(`  ${c.dim}${c.bold}${headerLine}${c.reset}\n`);

  // Rows
  for (const row of rows) {
    const rowLine = columns
      .map((col) => {
        const val = String(row[col.key] ?? "");
        const stripped = val.replace(/\x1b\[[0-9;]*m/g, "");
        const pad = widths[col.key] - stripped.length;
        if (col.align === "right") {
          return " ".repeat(Math.max(0, pad)) + val;
        }
        return val + " ".repeat(Math.max(0, pad));
      })
      .join("  ");
    process.stdout.write(`  ${rowLine}\n`);
  }
}

// ── Progress bar ──

function progressBar(current, total, width = 30) {
  const pct = Math.min(1, current / total);
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
  return `${bar} ${Math.round(pct * 100)}%`;
}

// ── Duration formatting ──

function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatAge(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

module.exports = {
  c,
  severityColor,
  trendIcon,
  spinner,
  json,
  ndjson,
  heading,
  subheading,
  info,
  success,
  warn,
  error,
  line,
  blank,
  indent,
  label,
  divider,
  table,
  progressBar,
  formatDuration,
  formatAge,
};
