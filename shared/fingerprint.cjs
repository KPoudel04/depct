'use strict';

/**
 * shared/fingerprint.cjs — ID generation and message normalization for Depct v2
 * Provides deterministic error fingerprinting for grouping.
 */

const crypto = require('node:crypto');

/**
 * Generate a prefixed error ID.
 */
function generateErrorId() {
  return 'err_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Generate a prefixed trace ID.
 */
function generateTraceId() {
  return 'tr_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Generate a prefixed span ID.
 */
function generateSpanId() {
  return 'sp_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Normalize an error message for grouping.
 * Replaces variable parts (identifiers, numbers, paths) with placeholders
 * so structurally identical errors group together.
 *
 * Example:
 *   "Cannot read property 'foo' of undefined"
 *   => "Cannot read property '{key}' of {nullish}"
 */
function normalizeMessage(message) {
  if (typeof message !== 'string' || !message) return '';

  let normalized = message;

  // Replace quoted property names: 'foo' or "foo"
  normalized = normalized.replace(/['"]([^'"]{1,60})['"]/g, "'{key}'");

  // Replace "of undefined" / "of null"
  normalized = normalized.replace(/\bof (undefined|null)\b/g, 'of {nullish}');

  // Replace specific numeric values
  normalized = normalized.replace(/\b\d{1,10}\b/g, '{n}');

  // Replace file paths (Unix and Windows)
  normalized = normalized.replace(/(?:\/[\w.-]+){2,}/g, '{path}');
  normalized = normalized.replace(/(?:[A-Z]:\\[\w\\.-]+)/gi, '{path}');

  // Replace UUIDs
  normalized = normalized.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '{uuid}'
  );

  // Replace hex strings (16+ chars)
  normalized = normalized.replace(/\b[0-9a-f]{16,}\b/gi, '{hex}');

  // Replace URLs
  normalized = normalized.replace(/https?:\/\/[^\s,)]+/g, '{url}');

  // Replace email addresses
  normalized = normalized.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '{email}');

  return normalized;
}

/**
 * SHA-256 hash of the raw error message, prefixed with "sha256:".
 */
function hashMessage(message) {
  if (typeof message !== 'string' || !message) return '';
  const hash = crypto.createHash('sha256').update(message).digest('hex');
  return 'sha256:' + hash;
}

/**
 * Generate a unique group ID for error clustering.
 */
function generateGroupId() {
  return 'eg_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Generate a fingerprint for an error based on location + error identity.
 * fingerprint = sha256(file + function + error_class + normalized_message_template)
 */
function computeFingerprint(file, functionName, errorClass, message) {
  const normalized = normalizeMessage(message);
  const input = `${file}:${functionName}:${errorClass}:${normalized}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

module.exports = {
  generateErrorId,
  generateTraceId,
  generateSpanId,
  generateGroupId,
  normalizeMessage,
  hashMessage,
  computeFingerprint,
};
