/**
 * register.mjs — ESM entry point for depct loader
 *
 * Used via: node --import depct/loader/register.mjs app.mjs
 *
 * Bootstraps the CJS loader which:
 * - Patches http.createServer for request tracing
 * - Installs global error handlers (uncaughtException, unhandledRejection)
 * - Patches http/https outbound for external call tracking
 * - Patches database clients (pg, mysql2, better-sqlite3)
 * - Installs Module._load hook (catches any require() calls from ESM code)
 *
 * For ESM projects: HTTP-level instrumentation, error capture, and external
 * call tracking work fully. Per-function arg shape capture works for any
 * CJS modules loaded via createRequire() or dynamic import of CJS files.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  require('./index.cjs');
} catch (err) {
  try {
    process.stderr.write(`[depct-loader] ESM bootstrap warning: ${err.message}\n`);
  } catch { /* */ }
}
