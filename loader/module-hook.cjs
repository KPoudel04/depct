'use strict';

/**
 * module-hook.cjs — Module._load patching for Depct v2
 *
 * Intercepts require() calls to wrap exported functions with instrumentation.
 * Respects include/exclude configuration. Fail-open: never crashes module loading.
 */

const Module = require('node:module');
const path = require('node:path');
const { wrapExportedMembers } = require('./wrap.cjs');

const MODULE_HOOK_MARKER = Symbol.for('depct.v2.moduleHookInstalled');

function debugLog(config, msg) {
  if (config.debug) {
    try { process.stderr.write(`[depct-loader] ${msg}\n`); } catch { /* */ }
  }
}

function toPosix(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

function pathContainsSegment(relativePathPosix, segment) {
  const normalized = segment.replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  return (
    relativePathPosix === normalized ||
    relativePathPosix.startsWith(`${normalized}/`) ||
    relativePathPosix.includes(`/${normalized}/`) ||
    relativePathPosix.endsWith(`/${normalized}`)
  );
}

function matchesInclude(relativePathPosix, includeList) {
  if (!includeList || includeList.length === 0) return true;
  return includeList.some((entry) => {
    const token = entry.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^\/+|\/+$/g, '');
    if (!token) return true;
    return pathContainsSegment(relativePathPosix, token);
  });
}

function matchesExclude(relativePathPosix, excludeList) {
  if (!excludeList || excludeList.length === 0) return false;
  return excludeList.some((entry) => {
    const token = entry.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^\/+|\/+$/g, '');
    if (!token) return false;
    return pathContainsSegment(relativePathPosix, token);
  });
}

function shouldInstrumentFile(filePath, config) {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  if (!filePath.startsWith(config.rootDir)) return false;

  const ext = path.extname(filePath);
  if (ext && !config.instrumentExtensions.has(ext)) return false;

  const relPosix = toPosix(path.relative(config.rootDir, filePath));
  if (relPosix.startsWith('../')) return false;

  if (!matchesInclude(relPosix, config.include)) return false;
  if (matchesExclude(relPosix, config.exclude)) return false;

  return true;
}

/**
 * Install the Module._load hook for function instrumentation.
 *
 * @param {object} options
 * @param {object} options.config - Loader configuration
 * @param {object} options.transport - Transport instance
 * @param {object} [options.hooks] - Hooks system instance
 */
function installModuleHook({ config, transport, hooks }) {
  if (Module._load[MODULE_HOOK_MARKER]) return;

  const originalLoad = Module._load;

  Module._load = function depctV2PatchedModuleLoad(request, parent, isMain) {
    let loaded = originalLoad.apply(this, arguments);

    try {
      const resolved = Module._resolveFilename(request, parent, isMain);

      if (!shouldInstrumentFile(resolved, config)) {
        return loaded;
      }

      loaded = wrapExportedMembers(loaded, {
        config,
        filePath: resolved,
        transport,
        hooks,
      });

      debugLog(config, `Instrumented: ${toPosix(path.relative(config.rootDir, resolved))}`);
    } catch {
      // Fail-open: never crash user app due to loader internals
    }

    return loaded;
  };

  Object.defineProperty(Module._load, MODULE_HOOK_MARKER, {
    configurable: false, enumerable: false, writable: false, value: true,
  });

  debugLog(config, 'Module._load hook installed.');
}

module.exports = {
  installModuleHook,
  shouldInstrumentFile,
};
