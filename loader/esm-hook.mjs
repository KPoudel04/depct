/**
 * esm-hook.mjs — placeholder for future ESM per-function instrumentation
 *
 * Currently, ESM support works via --require (CJS bootstrap) which patches:
 * - http.createServer (request tracing)
 * - Global error handlers (error capture with stack traces)
 * - http/https outbound (external dependency tracking)
 * - Database clients (query tracking)
 * - Module._load (catches CJS require() calls from ESM modules)
 *
 * Per-function arg shape capture for pure ESM exports requires either:
 * - A source-rewriting loader hook with a proper JS parser (acorn/swc)
 * - Or V8 inspector-based instrumentation
 *
 * This is planned for a future release.
 */

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
