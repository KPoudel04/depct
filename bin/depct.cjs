#!/usr/bin/env node

"use strict";

/**
 * depct CLI entry point
 *
 * Parses argv and dispatches to the appropriate command.
 * Zero external dependencies — Node built-ins only.
 */

const { run } = require("../src/index.cjs");

run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`\x1b[31mfatal\x1b[0m ${err.message}\n`);
  if (process.env.DEPCT_DEBUG) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
