'use strict';

/**
 * transport.cjs — HTTP transport with priority error flushing for Depct v2
 *
 * KEY V2 FEATURE: Error events flush immediately via a priority transport path.
 * Normal events batch in a ring buffer and flush on size/interval thresholds.
 * Zero external dependencies. Fail-open on all network errors.
 */

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const nodePath = require('node:path');

// ── HTTP posting ──

function buildEventsUrl(config) {
  const base = config.serverUrl.endsWith('/')
    ? config.serverUrl.slice(0, -1)
    : config.serverUrl;
  const evPath = config.eventsPath.startsWith('/')
    ? config.eventsPath
    : `/${config.eventsPath}`;
  return `${base}${evPath}`;
}

function requestViaHttp(urlString, payload, headers) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-length': Buffer.byteLength(payload),
            ...headers,
          },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`POST failed: ${res.statusCode}`));
          }
        }
      );

      req.on('timeout', () => req.destroy(new Error('POST timeout')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function postJson(url, payload, headers) {
  if (typeof globalThis.fetch === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    if (typeof timeout.unref === 'function') timeout.unref();

    try {
      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        keepalive: true,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`POST failed: ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    return;
  }

  await requestViaHttp(url, payload, headers);
}

// ── Ring buffer for normal events ──

function createRingBuffer(maxSize) {
  const buffer = new Array(maxSize);
  let writeIndex = 0;
  let count = 0;

  return {
    push(event) {
      buffer[writeIndex] = event;
      writeIndex = (writeIndex + 1) % maxSize;
      if (count < maxSize) count++;
    },

    drain() {
      if (count === 0) return [];

      const events = [];
      const start = count < maxSize ? 0 : writeIndex;
      for (let i = 0; i < count; i++) {
        const idx = (start + i) % maxSize;
        if (buffer[idx] != null) {
          events.push(buffer[idx]);
          buffer[idx] = null;
        }
      }
      count = 0;
      writeIndex = 0;
      return events;
    },

    get length() {
      return count;
    },
  };
}

// ── Transport factory ──

// ── Local SQLite persistence ──

async function initLocalDbAsync(config) {
  try {
    const dbDir = nodePath.join(config.rootDir || process.cwd(), '.depct');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = nodePath.join(dbDir, 'depct.db');

    const { createDatabaseWithSchema } = require('../shared/db.cjs');
    const db = await createDatabaseWithSchema(dbPath);

    // Init the project
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, datetime('now'))`
    ).run(config.projectId, config.projectId);
    db.save();
    db.startAutoSave(2000);

    return db;
  } catch (err) {
    try {
      process.stderr.write(`[depct-loader] Local DB init failed: ${err.message}\n`);
    } catch { /* */ }
    return null;
  }
}

function persistEventsToDb(db, events, config) {
  if (!db || events.length === 0) return;

  try {
    const { computeFingerprint, normalizeMessage, generateGroupId, generateErrorId } =
      require('../shared/fingerprint.cjs');

    const stmtUpsertGroup = db.prepare(`
      INSERT INTO error_groups (id, project_id, fingerprint, error_class, message_template,
        trigger_function, trigger_file, trigger_line, first_seen_at, last_seen_at, occurrence_count, status)
      VALUES (@id, @project_id, @fingerprint, @error_class, @message_template,
        @trigger_function, @trigger_file, @trigger_line, @first_seen_at, @last_seen_at, 1, 'open')
      ON CONFLICT(project_id, fingerprint) DO UPDATE SET
        last_seen_at = @last_seen_at,
        occurrence_count = error_groups.occurrence_count + 1,
        error_class = @error_class,
        message_template = @message_template
    `);

    const stmtGetGroup = db.prepare(
      `SELECT id FROM error_groups WHERE project_id = ? AND fingerprint = ?`
    );

    const stmtInsertOccurrence = db.prepare(`
      INSERT OR IGNORE INTO error_occurrences (id, group_id, trace_id, timestamp, causal_chain,
        args_shape_at_failure, environment, preceding_success_count, preceding_success_shapes)
      VALUES (@id, @group_id, @trace_id, @timestamp, @causal_chain,
        @args_shape_at_failure, @environment, @preceding_success_count, @preceding_success_shapes)
    `);

    const stmtUpsertFrequency = db.prepare(`
      INSERT INTO error_frequency (group_id, bucket, count)
      VALUES (?, ?, 1)
      ON CONFLICT(group_id, bucket) DO UPDATE SET count = error_frequency.count + 1
    `);

    const stmtInsertSpan = db.prepare(`
      INSERT OR IGNORE INTO spans (id, project_id, trace_id, parent_span_id, node_id,
        function_name, file_path, kind, start_time, end_time, duration_ms, status, error_id, args_shape, response_shape)
      VALUES (@id, @project_id, @trace_id, @parent_span_id, @node_id,
        @function_name, @file_path, @kind, @start_time, @end_time, @duration_ms, @status, @error_id, @args_shape, @response_shape)
    `);

    const stmtUpsertFunctionStats = db.prepare(`
      INSERT INTO function_stats (project_id, node_id, function_name, file_path, invocation_count, error_count, last_invoked_at)
      VALUES (@project_id, @node_id, @function_name, @file_path, 1, @error_count, @last_invoked_at)
      ON CONFLICT(project_id, node_id) DO UPDATE SET
        invocation_count = function_stats.invocation_count + 1,
        error_count = function_stats.error_count + @error_count,
        last_invoked_at = @last_invoked_at
    `);

    const insertAll = db.transaction((evts) => {
      for (const event of evts) {
        try {
          if (event.type === 'error') {
            // Persist error event
            const trigger = event.trigger || {};
            const errObj = event.error || {};
            const fp = computeFingerprint(
              trigger.file || '', trigger.function || '',
              errObj.class || 'Error', errObj.message_normalized || errObj.message || ''
            );
            const now = event.timestamp || new Date().toISOString();
            const groupId = generateGroupId();

            stmtUpsertGroup.run({
              id: groupId,
              project_id: config.projectId,
              fingerprint: fp,
              error_class: errObj.class || 'Error',
              message_template: errObj.message_normalized || normalizeMessage(errObj.message || ''),
              trigger_function: trigger.function || 'unknown',
              trigger_file: trigger.file || 'unknown',
              trigger_line: trigger.line || 0,
              first_seen_at: now,
              last_seen_at: now,
            });

            const row = stmtGetGroup.get(config.projectId, fp);
            const actualGroupId = row ? row.id : groupId;
            const bucket = now.slice(0, 13); // hourly bucket

            stmtInsertOccurrence.run({
              id: event.error_id || generateErrorId(),
              group_id: actualGroupId,
              trace_id: event.trace_id || '',
              timestamp: now,
              causal_chain: JSON.stringify(event.causal_chain || []),
              args_shape_at_failure: typeof trigger.args_shape_at_failure === 'string' ? trigger.args_shape_at_failure : trigger.args_shape_at_failure != null ? JSON.stringify(trigger.args_shape_at_failure) : null,
              environment: JSON.stringify(event.context || {}),
              preceding_success_count: event.preceding_successes || 0,
              preceding_success_shapes: typeof event.preceding_success_shapes === 'string' ? event.preceding_success_shapes : event.preceding_success_shapes != null ? JSON.stringify(event.preceding_success_shapes) : null,
            });

            stmtUpsertFrequency.run(actualGroupId, bucket);

          } else if (event.type === 'span.start' || event.type === 'span.finish') {
            // Persist span event
            const nodeId = event.node_id || `${event.file || ''}:${event.function || ''}`;
            const funcName = event.function || event.function_name || nodeId.split(':').pop() || '';
            const filePath = event.file || event.file_path || nodeId.split(':')[0] || '';

            if (event.type === 'span.finish') {
              stmtInsertSpan.run({
                id: event.span_id || '',
                project_id: config.projectId,
                trace_id: event.trace_id || '',
                parent_span_id: event.parent_span_id || null,
                node_id: nodeId,
                function_name: funcName,
                file_path: filePath,
                kind: event.kind || null,
                start_time: event.start_time || event.timestamp || '',
                end_time: event.timestamp || '',
                duration_ms: event.duration_ms || null,
                status: event.status || 'ok',
                error_id: event.error_id || null,
                args_shape: event.args_shape ? JSON.stringify(event.args_shape) : null,
                response_shape: event.response_shape ? JSON.stringify(event.response_shape) : null,
              });

              stmtUpsertFunctionStats.run({
                project_id: config.projectId,
                node_id: nodeId,
                function_name: funcName,
                file_path: filePath,
                error_count: (event.status === 'error' || event.error_id) ? 1 : 0,
                last_invoked_at: event.timestamp || new Date().toISOString(),
              });
            }
          }
        } catch (e) {
          // Fail-open: skip this event, don't crash
        }
      }
    });

    insertAll(events);
  } catch (err) {
    try {
      process.stderr.write(`[depct-loader] Local persist error: ${err.message}\n`);
    } catch { /* */ }
  }
}

function createTransport(config) {
  const endpointUrl = buildEventsUrl(config);
  const ringBuffer = createRingBuffer(config.flushMaxEvents * 10); // 10x batch for ring
  const priorityQueue = []; // Error events flush immediately
  let flushTimer = null;
  let flushing = false;
  let priorityFlushing = false;
  let localEvents = []; // For DEPCT_LOCAL mode: store events in-memory
  let localDb = null; // SQLite DB for local persistence
  let localDbReady = false;

  if (config.local) {
    // Init DB asynchronously — events buffer until ready
    initLocalDbAsync(config).then((db) => {
      localDb = db;
      localDbReady = true;
      // Flush any events that buffered while DB was initializing
      if (localEvents.length > 0) {
        persistEventsToDb(localDb, localEvents.splice(0), config);
      }
    }).catch(() => { /* fail-open */ });
  }

  function debugLog(msg) {
    if (config.debug) {
      try { process.stderr.write(`[depct-loader] ${msg}\n`); } catch { /* */ }
    }
  }

  function buildHeaders() {
    const headers = {
      'content-type': 'application/json',
      'x-depct-project-id': config.projectId,
      'x-depct-run-id': config.runId,
      'x-depct-loader-version': '2.0.0',
    };
    if (config.projectToken) {
      headers['authorization'] = `Bearer ${config.projectToken}`;
    }
    return headers;
  }

  // ── Priority flush: error events go out immediately ──

  async function flushPriority() {
    if (priorityFlushing || priorityQueue.length === 0) return;
    priorityFlushing = true;

    const batch = priorityQueue.splice(0, priorityQueue.length);

    if (config.local) {
      localEvents.push(...batch);
      persistEventsToDb(localDb, batch, config);
      priorityFlushing = false;
      debugLog(`Stored ${batch.length} priority events locally.`);
      return;
    }

    const payload = JSON.stringify({
      projectId: config.projectId,
      runId: config.runId,
      trigger: 'priority',
      schema_version: '2.0',
      events: batch,
    });

    try {
      await postJson(endpointUrl, payload, buildHeaders());
      debugLog(`Flushed ${batch.length} priority events.`);
    } catch (err) {
      debugLog(`Dropped ${batch.length} priority events: ${err.message}`);
    } finally {
      priorityFlushing = false;
    }
  }

  // ── Normal batch flush ──

  async function flush(trigger) {
    if (flushing) return;

    const batch = ringBuffer.drain();
    if (batch.length === 0) return;

    flushing = true;

    if (config.local) {
      localEvents.push(...batch);
      persistEventsToDb(localDb, batch, config);
      flushing = false;
      debugLog(`Stored ${batch.length} events locally (${trigger}).`);
      return;
    }

    const payload = JSON.stringify({
      projectId: config.projectId,
      runId: config.runId,
      trigger: trigger || 'manual',
      schema_version: '2.0',
      events: batch,
    });

    try {
      await postJson(endpointUrl, payload, buildHeaders());
      debugLog(`Flushed ${batch.length} events (${trigger}).`);
    } catch (err) {
      debugLog(`Dropped ${batch.length} events: ${err.message}`);
    } finally {
      flushing = false;
    }
  }

  // ── Enqueue ──

  function enqueue(event) {
    if (!event) return;

    // Error events get priority transport
    if (event.type === 'error' || event.is_error === true) {
      priorityQueue.push(event);
      // Fire-and-forget immediate flush
      void flushPriority();
      return;
    }

    ringBuffer.push(event);

    if (ringBuffer.length >= config.flushMaxEvents) {
      void flush('size');
    }
  }

  // ── Lifecycle ──

  function start() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      void flush('interval');
    }, config.flushIntervalMs);

    if (typeof flushTimer.unref === 'function') {
      flushTimer.unref();
    }
  }

  async function stop() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    await flushPriority();
    await flush('shutdown');
  }

  /**
   * Get locally stored events (only useful in DEPCT_LOCAL mode).
   */
  function getLocalEvents() {
    return localEvents;
  }

  return {
    enqueue,
    flush,
    flushPriority,
    start,
    stop,
    getLocalEvents,
  };
}

module.exports = { createTransport };
