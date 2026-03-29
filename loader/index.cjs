'use strict';

/**
 * index.cjs — Entry point for Depct v2 Loader (Capture Engine)
 *
 * Bootstraps instrumentation: loads config, initializes the plugin system,
 * activates plugins, installs module hooks, and starts the transport.
 *
 * Uses a global Symbol to prevent double-initialization in monorepo setups
 * or when required multiple times.
 *
 * CRITICAL INVARIANT: This file NEVER crashes the host application.
 * Every operation is wrapped in try-catch with fail-open semantics.
 */

const LOADER_INIT = Symbol.for('depct.v2.loaderInitialized');

if (!global[LOADER_INIT]) {
  global[LOADER_INIT] = true;

  try {
    const { loadConfig } = require('./config.cjs');
    const { createTransport } = require('./transport.cjs');
    const { createHooks } = require('./hooks.cjs');
    const { installModuleHook } = require('./module-hook.cjs');

    // ── Load configuration ──
    const config = loadConfig();

    if (config.debug) {
      try {
        process.stderr.write(
          `[depct-loader] v2.0.0 initializing for project "${config.projectId}" (run: ${config.runId})\n`
        );
      } catch { /* */ }
    }

    // ── Create transport ──
    const transport = createTransport(config);

    // ── Create hooks system ──
    const hooks = createHooks();

    // ── Load and activate plugins ──
    const pluginModules = [
      './plugins/error-capture.cjs',
      './plugins/function-trace.cjs',
      './plugins/http-inbound.cjs',
      './plugins/http-outbound.cjs',
      './plugins/db-patch.cjs',
    ];

    const activePlugins = [];

    for (const pluginPath of pluginModules) {
      try {
        const plugin = require(pluginPath);

        if (!plugin || !plugin.name) {
          continue;
        }

        // Check if plugin should activate based on config
        if (typeof plugin.shouldActivate === 'function' && !plugin.shouldActivate(config)) {
          if (config.debug) {
            try {
              process.stderr.write(`[depct-loader] Plugin "${plugin.name}" skipped (disabled by config).\n`);
            } catch { /* */ }
          }
          continue;
        }

        // Create a plugin-specific hooks API
        const pluginAPI = hooks.createPluginAPI(plugin.name);

        // Activate the plugin
        plugin.activate(pluginAPI, { config, transport });

        activePlugins.push(plugin.name);

        if (config.debug) {
          try {
            process.stderr.write(
              `[depct-loader] Plugin "${plugin.name}" v${plugin.version || '?'} activated.\n`
            );
          } catch { /* */ }
        }
      } catch (err) {
        // Fail-open: if a plugin fails to load/activate, skip it
        try {
          process.stderr.write(
            `[depct-loader] Plugin at "${pluginPath}" failed to activate: ${err.message}\n`
          );
        } catch { /* */ }
      }
    }

    // ── Install Module._load hook for function instrumentation ──
    try {
      installModuleHook({ config, transport, hooks });
    } catch (err) {
      try {
        process.stderr.write(`[depct-loader] Module hook installation failed: ${err.message}\n`);
      } catch { /* */ }
    }

    // ── Start transport (begins flush timer) ──
    transport.start();

    // ── Expose internals for ESM hooks and framework integrations ──
    global[Symbol.for('depct.v2.config')] = config;
    global[Symbol.for('depct.v2.transport')] = transport;
    global[Symbol.for('depct.v2.hooks')] = hooks;

    // ── Graceful shutdown ──
    const shutdown = async () => {
      try {
        await transport.stop();
      } catch { /* */ }
    };

    process.on('beforeExit', () => { void shutdown(); });

    // SIGTERM/SIGINT: attempt flush before exit
    const onSignal = () => {
      void shutdown().finally(() => {
        // Don't call process.exit — let the app handle its own shutdown
      });
    };

    // Only add signal handlers if no existing ones (avoid interfering with app)
    if (process.listenerCount('SIGTERM') === 0) {
      process.once('SIGTERM', onSignal);
    }

    if (config.debug) {
      try {
        process.stderr.write(
          `[depct-loader] Initialized with ${activePlugins.length} plugins: ${activePlugins.join(', ')}\n`
        );
        process.stderr.write(
          `[depct-loader] Config: rootDir=${config.rootDir}, sampleRate=${config.sampleRate}, local=${config.local}\n`
        );
      } catch { /* */ }
    }
  } catch (err) {
    // CRITICAL: The loader itself failed. Do not crash the host app.
    try {
      process.stderr.write(`[depct-loader] Initialization failed (app unaffected): ${err.message}\n`);
    } catch { /* */ }
  }
}

// ── Public API ──

/**
 * Ensure the loader is initialized. Safe to call multiple times.
 * Used by framework integrations (Next.js instrumentation.ts, etc.)
 */
function installHooks() {
  // The top-level code above already runs on first require().
  // This function exists for explicit framework integration.
}

/**
 * Get the transport instance (for framework integrations that need to flush).
 */
function getTransport() {
  return global[Symbol.for('depct.v2.transport')] || null;
}

/**
 * Get the hooks instance (for custom plugin registration).
 */
function getHooks() {
  return global[Symbol.for('depct.v2.hooks')] || null;
}

/**
 * Get the config (for inspection/debugging).
 */
function getConfig() {
  return global[Symbol.for('depct.v2.config')] || null;
}

module.exports = {
  installHooks,
  getTransport,
  getHooks,
  getConfig,
};
