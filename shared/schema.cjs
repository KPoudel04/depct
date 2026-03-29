'use strict';

/**
 * shared/schema.cjs — Event schema constants and validation for Depct v2
 */

const SCHEMA_VERSION = '2.0';

const REQUIRED_ERROR_FIELDS = [
  'schema_version',
  'type',
  'error_id',
  'trace_id',
  'timestamp',
  'project_id',
  'error',
];

const REQUIRED_ERROR_SUBFIELDS = ['class', 'message_normalized', 'stack'];

/**
 * Validate an error event against the v2.0 schema.
 * Returns { valid: true } or { valid: false, errors: [...] }.
 */
function validateErrorEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event must be a non-null object'] };
  }

  for (const field of REQUIRED_ERROR_FIELDS) {
    if (event[field] == null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (event.schema_version && event.schema_version !== SCHEMA_VERSION) {
    errors.push(`Invalid schema_version: expected "${SCHEMA_VERSION}", got "${event.schema_version}"`);
  }

  if (event.type && event.type !== 'error') {
    errors.push(`Invalid type for error event: expected "error", got "${event.type}"`);
  }

  if (event.error && typeof event.error === 'object') {
    for (const field of REQUIRED_ERROR_SUBFIELDS) {
      if (event.error[field] == null) {
        errors.push(`Missing required error sub-field: error.${field}`);
      }
    }

    if (event.error.stack && !Array.isArray(event.error.stack)) {
      errors.push('error.stack must be an array of stack frames');
    }
  }

  if (event.causal_chain && !Array.isArray(event.causal_chain)) {
    errors.push('causal_chain must be an array');
  }

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

/**
 * Validate a span event (start or finish).
 */
function validateSpanEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event must be a non-null object'] };
  }

  const required = ['schema_version', 'type', 'span_id', 'trace_id', 'timestamp', 'project_id'];
  for (const field of required) {
    if (event[field] == null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

module.exports = {
  SCHEMA_VERSION,
  validateErrorEvent,
  validateSpanEvent,
};
