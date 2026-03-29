'use strict';

/**
 * hooks.cjs — Plugin hook system for Depct v2
 *
 * Provides the registration and dispatch mechanism for plugin hooks.
 * Each hook is a named channel that plugins can subscribe to.
 * All hook dispatch is wrapped in try-catch for fail-open safety.
 */

/**
 * Create a hooks registry.
 * Plugins register callbacks against named hooks.
 * The system dispatches events to all registered callbacks.
 */
function createHooks() {
  const registry = new Map();
  const disabledPlugins = new Set();

  function ensureHook(name) {
    if (!registry.has(name)) {
      registry.set(name, []);
    }
    return registry.get(name);
  }

  /**
   * Register a callback for a named hook.
   * @param {string} hookName - Hook channel name
   * @param {function} callback - Handler function
   * @param {string} [pluginName] - Owner plugin name (for disable tracking)
   */
  function on(hookName, callback, pluginName) {
    if (typeof callback !== 'function') return;
    const handlers = ensureHook(hookName);
    handlers.push({ callback, pluginName: pluginName || 'unknown' });
  }

  /**
   * Dispatch an event to all handlers on a named hook.
   * Fail-open: if a handler throws, it is caught and the plugin may be disabled.
   *
   * @param {string} hookName - Hook channel name
   * @param {...*} args - Arguments to pass to each handler
   * @returns {Array} Array of results from handlers that succeeded
   */
  function dispatch(hookName, ...args) {
    const handlers = registry.get(hookName);
    if (!handlers || handlers.length === 0) return [];

    const results = [];

    for (const handler of handlers) {
      if (disabledPlugins.has(handler.pluginName)) continue;

      try {
        const result = handler.callback(...args);
        if (result !== undefined) results.push(result);
      } catch (err) {
        // Fail-open: disable the plugin that threw
        disabledPlugins.add(handler.pluginName);
        try {
          process.stderr.write(
            `[depct-loader] Plugin "${handler.pluginName}" disabled after error in hook "${hookName}": ${err.message}\n`
          );
        } catch {
          // Even stderr write can fail; swallow everything
        }
      }
    }

    return results;
  }

  /**
   * Create the plugin-facing hooks API.
   * This is the object passed to plugin.activate(hooks).
   */
  function createPluginAPI(pluginName) {
    return {
      // Function lifecycle
      onFunctionCall(cb) { on('function.call', cb, pluginName); },
      onFunctionReturn(cb) { on('function.return', cb, pluginName); },
      onFunctionError(cb) { on('function.error', cb, pluginName); },

      // HTTP inbound
      onRequest(cb) { on('http.request', cb, pluginName); },
      onResponse(cb) { on('http.response', cb, pluginName); },

      // HTTP outbound
      onOutboundRequest(cb) { on('http.outbound.request', cb, pluginName); },
      onOutboundResponse(cb) { on('http.outbound.response', cb, pluginName); },

      // Database
      onDbQuery(cb) { on('db.query', cb, pluginName); },
      onDbResult(cb) { on('db.result', cb, pluginName); },
      onDbError(cb) { on('db.error', cb, pluginName); },

      // Transport
      onBeforeFlush(cb) { on('transport.beforeFlush', cb, pluginName); },
      onAfterFlush(cb) { on('transport.afterFlush', cb, pluginName); },

      // General
      on(hookName, cb) { on(hookName, cb, pluginName); },
    };
  }

  /**
   * Check if a plugin is disabled.
   */
  function isDisabled(pluginName) {
    return disabledPlugins.has(pluginName);
  }

  /**
   * Get list of disabled plugins.
   */
  function getDisabledPlugins() {
    return Array.from(disabledPlugins);
  }

  return {
    on,
    dispatch,
    createPluginAPI,
    isDisabled,
    getDisabledPlugins,
  };
}

module.exports = { createHooks };
