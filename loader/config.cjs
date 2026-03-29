'use strict';

/**
 * config.cjs — Configuration loader for Depct v2
 *
 * Loads configuration from environment variables and .depctrc files.
 * All values have sensible defaults. Fail-open: invalid config never crashes the host.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEPCTRC_NAME = '.depctrc';

const DEFAULT_EXCLUDE = [
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.next',
  '.nuxt',
  'packages/loader',
];

const INSTRUMENT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx']);

// ── Parsing helpers ──

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(n)) return true;
  if (['0', 'false', 'no', 'off'].includes(n)) return false;
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createRunId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

// ── .depctrc loader ──

function loadDepctrc(rootDir) {
  try {
    const rcPath = path.resolve(rootDir, DEPCTRC_NAME);
    if (fs.existsSync(rcPath)) {
      return JSON.parse(fs.readFileSync(rcPath, 'utf8'));
    }
  } catch {
    // Fail-open: ignore parse errors
  }
  return null;
}

// ── Main config loader ──

function loadConfig() {
  const cwd = process.cwd();
  const rootDir = path.resolve(process.env.DEPCT_PROJECT_ROOT || cwd);
  const rc = loadDepctrc(rootDir);

  const projectId =
    process.env.DEPCT_PROJECT_ID ||
    (rc && rc.project_id) ||
    process.env.npm_package_name ||
    path.basename(rootDir) ||
    'depct-project';

  const serverUrl =
    process.env.DEPCT_SERVER_URL ||
    (rc && rc.server_url) ||
    'http://localhost:3007';

  const sampleRate = clamp(
    toNumber(process.env.DEPCT_SAMPLE_RATE, rc && rc.sample_rate != null ? rc.sample_rate : 1),
    0,
    1
  );

  const flushMaxEvents = Math.max(
    1,
    toInteger(process.env.DEPCT_FLUSH_MAX_EVENTS, rc && rc.flush_max_events != null ? rc.flush_max_events : 20)
  );

  const flushIntervalMs = Math.max(
    100,
    toInteger(process.env.DEPCT_FLUSH_INTERVAL_MS, rc && rc.flush_interval_ms != null ? rc.flush_interval_ms : 1500)
  );

  const envInclude = parseList(process.env.DEPCT_INCLUDE);
  const rcInclude = rc && Array.isArray(rc.include) ? rc.include : [];
  const include = envInclude.length > 0 ? envInclude : rcInclude;

  const envExclude = parseList(process.env.DEPCT_EXCLUDE);
  const rcExclude = rc && Array.isArray(rc.exclude) ? rc.exclude : [];
  const mergedExclude = envExclude.length > 0 ? envExclude : rcExclude;
  const exclude = [...DEFAULT_EXCLUDE, ...mergedExclude];

  const local = toBoolean(
    process.env.DEPCT_LOCAL,
    rc && rc.local != null ? rc.local : false
  );

  const debug = toBoolean(process.env.DEPCT_DEBUG, false);

  const projectToken =
    process.env.DEPCT_PROJECT_TOKEN ||
    (rc && rc.project_token) ||
    '';

  const runId = process.env.DEPCT_RUN_ID || createRunId();

  const eventsPath = process.env.DEPCT_EVENTS_PATH || '/v1/events';

  const errorCapture = toBoolean(
    process.env.DEPCT_ERROR_CAPTURE,
    rc && rc.error_capture != null ? rc.error_capture : true
  );

  const functionTrace = toBoolean(
    process.env.DEPCT_FUNCTION_TRACE,
    rc && rc.function_trace != null ? rc.function_trace : true
  );

  const httpInbound = toBoolean(
    process.env.DEPCT_HTTP_INBOUND,
    rc && rc.http_inbound != null ? rc.http_inbound : true
  );

  const httpOutbound = toBoolean(
    process.env.DEPCT_HTTP_OUTBOUND,
    rc && rc.http_outbound != null ? rc.http_outbound : true
  );

  const dbCapture = toBoolean(
    process.env.DEPCT_DB_CAPTURE,
    rc && rc.db_capture != null ? rc.db_capture : true
  );

  return {
    projectId,
    projectToken,
    runId,
    rootDir,
    serverUrl,
    eventsPath,
    sampleRate,
    flushMaxEvents,
    flushIntervalMs,
    include,
    exclude,
    local,
    debug,
    instrumentExtensions: INSTRUMENT_EXTENSIONS,
    // Plugin-level feature flags
    errorCapture,
    functionTrace,
    httpInbound,
    httpOutbound,
    dbCapture,
  };
}

module.exports = { loadConfig };
