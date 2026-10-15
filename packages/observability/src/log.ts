import { context, trace, type Attributes } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

type TelemetryEvent =
  | 'main_listening'
  | 'main_stopped'
  | 'main_relay_started'
  | 'main_relay_stopped'
  | 'account_listening'
  | 'account_stopped'
  | 'account_email_unavailable'
  | 'worker_run_failed'
  | 'worker_run_deferred'
  | 'worker_fault'
  | 'library_backfill'
  | 'request_completed';

const allowed = new Set([
  'operation_id',
  'causation_id',
  'graph_epoch',
  'graph_sequence',
  'index_generation',
  'rezics.worker.name',
  'rezics.worker.outcome',
  'rezics.worker.trigger',
  'error.class',
  'error.message',
  'error.chain.messages',
  'error.code',
  'error.sqlstate',
  'error.chain.classes',
  'error.chain.codes',
  'rezics.backfill.examined',
  'rezics.backfill.skipped',
  'rezics.backfill.duration_ms',
  'rezics.checkout.outer',
  'rezics.checkout.inner',
  'rezics.checkout.pool',
  'rezics.checkout.repeats',
  'rezics.checkout.tick',
  'rezics.relay.requested_sequence',
  'rezics.projection.checkpoint_sequence',
  'rezics.relay.data_epoch',
  'rezics.relay.routing_epoch',
  'rezics.relay.retention_floor',
  'rezics.relay.minimum_retained_sequence',
  'rezics.relay.newest_committed_sequence',
  'rezics.relay.newest_delivered_sequence',
  'rezics.relay.acknowledged_sequence',
  'rezics.relay.custody_supplied',
  'rezics.relay.custody_found',
  'rezics.projection.recovery_state',
  'rezics.projection.recovery_attempts',
  'rezics.projection.recovery_retry_ms',
]);
const counts = new Set([
  'rezics.backfill.examined',
  'rezics.backfill.skipped',
  'rezics.backfill.duration_ms',
  'rezics.projection.recovery_attempts',
  'rezics.projection.recovery_retry_ms',
]);
const relayDiagnosticPositions = new Set([
  'rezics.relay.retention_floor', 'rezics.relay.minimum_retained_sequence',
  'rezics.relay.newest_committed_sequence', 'rezics.relay.newest_delivered_sequence',
  'rezics.relay.acknowledged_sequence',
]);
const classToken = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const codeToken = /^[A-Za-z0-9_]{1,32}$/;
const sqlstateToken = /^[0-9A-Z]{5}$/;
const ERROR_CHAIN_LIMIT = 5;
const workerName = /^[a-z][a-z0-9._-]{0,63}$/;
/** Repository-relative caller `path:line` and an optional function name. */
const checkoutOrigin = /^[A-Za-z0-9_./:-]+:\d{1,7}(?: [A-Za-z_$][A-Za-z0-9_$.#]*)?$/;
const checkoutPool = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A worker tick name. Same bound as the tick runner: a short label, never a payload. */
const checkoutTick = /^[A-Za-z][\w.:-]{0,80}$/;
const emailAddress = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const personOrAgentIri =
  /https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|urn:rezics:agent:/i;
const sqlValue = /Key\s*\([^)\n]+\)\s*=\s*\(|\bVALUES\s*\(|=\s*'[^'\n]*'/i;

/** A console line must not carry an email, a person or Agent IRI, or a SQL literal. */
export function logLineCarriesPersonalData(line: string): boolean {
  return emailAddress.test(line) || personOrAgentIri.test(line) || sqlValue.test(line);
}

function publicAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowed.has(key) || value === undefined) continue;
    if (key === 'rezics.relay.requested_sequence' || key === 'rezics.projection.checkpoint_sequence') {
      if (typeof value === 'string' && /^(0|[1-9][0-9]{0,99})$/.test(value)) result[key] = value;
      continue;
    }
    if (relayDiagnosticPositions.has(key)) {
      if (typeof value === 'string' && (value === 'absent' || value === 'unavailable'
        || /^(0|[1-9][0-9]{0,99})$/.test(value))) result[key] = value;
      continue;
    }
    if (key === 'rezics.relay.custody_supplied' || key === 'rezics.relay.custody_found') {
      if (typeof value === 'boolean') result[key] = value;
      continue;
    }
    if (key === 'rezics.projection.recovery_state') {
      if (value === 'ready' || value === 'reconciling' || value === 'waiting-for-cut') result[key] = value;
      continue;
    }
    if (key === 'rezics.relay.data_epoch' || key === 'rezics.relay.routing_epoch') {
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) result[key] = value;
      continue;
    }
    if (key === 'rezics.checkout.outer') {
      if (!Array.isArray(value)) continue;
      const outers: string[] = [];
      for (const item of value) {
        if (outers.length === 3) break;
        if (typeof item === 'string' && item.length <= 200 && checkoutOrigin.test(item)
          && !logLineCarriesPersonalData(item)) outers.push(item);
      }
      if (outers.length) result[key] = outers;
      continue;
    }
    if (key === 'rezics.checkout.inner') {
      if (typeof value === 'string' && value.length <= 200 && checkoutOrigin.test(value)
        && !logLineCarriesPersonalData(value)) result[key] = value;
      continue;
    }
    if (key === 'rezics.checkout.pool') {
      if (typeof value === 'string' && checkoutPool.test(value) && !logLineCarriesPersonalData(value)) {
        result[key] = value;
      }
      continue;
    }
    if (key === 'rezics.checkout.repeats') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[key] = Math.trunc(value);
      continue;
    }
    if (key === 'rezics.checkout.tick') {
      if (typeof value === 'string' && checkoutTick.test(value) && !logLineCarriesPersonalData(value)) {
        result[key] = value;
      }
      continue;
    }
    if (counts.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.trunc(value);
      continue;
    }
    if (key === 'error.class') {
      if (typeof value === 'string' && classToken.test(value) && !logLineCarriesPersonalData(value)) result[key] = value;
      continue;
    }
    if (key === 'error.message') {
      const message = boundedMessage(value);
      if (message) result[key] = message;
      continue;
    }
    if (key === 'error.chain.messages') {
      if (Array.isArray(value)) {
        const messages = value.slice(0, ERROR_CHAIN_LIMIT).map(item => boundedMessage(item) ?? '[redacted]');
        if (messages.length) result[key] = messages;
      }
      continue;
    }
    if (key === 'error.code') {
      const code = boundedCodeValue(value);
      if (code) result[key] = code;
      continue;
    }
    if (key === 'error.sqlstate') {
      if (typeof value === 'string' && sqlstateToken.test(value)) result[key] = value;
      continue;
    }
    if (key === 'error.chain.classes' || key === 'error.chain.codes') {
      if (!Array.isArray(value)) continue;
      const tokens = value.slice(0, ERROR_CHAIN_LIMIT).flatMap(item => {
        if (key === 'error.chain.classes') return typeof item === 'string' && classToken.test(item)
          && !logLineCarriesPersonalData(item) ? [item] : [];
        return boundedCodeValue(item) ?? [];
      });
      if (tokens.length) result[key] = tokens;
      continue;
    }
    if (key === 'rezics.worker.name') {
      if (typeof value === 'string' && workerName.test(value) && !logLineCarriesPersonalData(value)) result[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      if (!logLineCarriesPersonalData(value)) result[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function boundedClass(error: unknown): string {
  const name = error instanceof Error ? error.constructor?.name : undefined;
  return typeof name === 'string' && classToken.test(name) ? name : 'Unknown';
}

/** Only provider codes are public; messages and arbitrary object fields are not. */
function boundedCodeValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isFinite(raw))) return undefined;
  return codeToken.test(String(raw)) ? String(raw) : undefined;
}

function boundedCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return boundedCodeValue((error as { code?: unknown }).code);
  }
  return undefined;
}

/** The outer error and at most four causes; cyclic chains stop at the first repeat. */
function boundedErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (chain.length < ERROR_CHAIN_LIMIT && current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/** Keep diagnostic prose bounded; omit messages containing identities, SQL or URLs. */
function boundedMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.length || value.length > 512
    || /[\r\n\x00-\x1f]|\b(?:SELECT|INSERT|UPDATE|DELETE|VALUES)\b|:\/\//i.test(value)
    || logLineCarriesPersonalData(value)) return undefined;
  return value;
}

/** Bounded diagnostic messages and causes, never stacks, rows or query text. */
export function logWorkerFault(worker: string, error: unknown,
  options: { messages?: boolean } = {}): void {
  const chain = boundedErrorChain(error);
  const messages = options.messages === false ? []
    : chain.map(item => item instanceof Error ? boundedMessage(item.message) : undefined);
  const codes = chain.flatMap(item => boundedCode(item) ?? []);
  const code = codes[0];
  const sqlstate = codes.find(value => sqlstateToken.test(value));
  telemetryLog('worker_fault', 'error', {
    ...(workerName.test(worker) && !logLineCarriesPersonalData(worker) ? { 'rezics.worker.name': worker } : {}),
    'error.class': boundedClass(error),
    ...(options.messages !== false && error instanceof Error && boundedMessage(error.message)
      ? { 'error.message': error.message } : {}),
    ...(code ? { 'error.code': code } : {}),
    ...(sqlstate ? { 'error.sqlstate': sqlstate } : {}),
    ...(chain.length > 1 ? { 'error.chain.classes': chain.map(boundedClass),
      ...(messages.some(Boolean) ? { 'error.chain.messages': messages.map(message => message ?? '[redacted]') } : {}),
      ...(codes.length ? { 'error.chain.codes': codes } : {}) } : {}),
    ...checkoutAttributes(error),
  });
}

function checkoutAttributes(error: unknown): Attributes {
  if (!(error instanceof Error) || error.name !== 'NestedPoolCheckoutError') return {};
  const fields = error as Error & {
    outers?: unknown; inner?: unknown; pool?: unknown; repeats?: unknown; tick?: unknown;
  };
  const attributes: Attributes = {};
  if (Array.isArray(fields.outers)) {
    const outers = fields.outers.filter((item): item is string => typeof item === 'string');
    if (outers.length) attributes['rezics.checkout.outer'] = outers;
  }
  if (typeof fields.inner === 'string' && fields.inner !== '') attributes['rezics.checkout.inner'] = fields.inner;
  if (typeof fields.pool === 'string') attributes['rezics.checkout.pool'] = fields.pool;
  if (typeof fields.repeats === 'number') attributes['rezics.checkout.repeats'] = fields.repeats;
  if (typeof fields.tick === 'string') attributes['rezics.checkout.tick'] = fields.tick;
  return attributes;
}

/** Event names and caller-selected public attributes only; never serialize Errors or request bodies. */
export function telemetryLog(
  event: TelemetryEvent,
  severity: 'info' | 'warn' | 'error' = 'info',
  attributes: Attributes = {},
) {
  attributes = publicAttributes(attributes);
  const span = trace.getSpanContext(context.active());
  const traced = span && trace.isSpanContextValid(span)
    ? { trace_id: span.traceId, span_id: span.spanId }
    : {};
  logs.getLogger('rezics').emit({
    body: event,
    severityText: severity.toUpperCase(),
    severityNumber:
      severity === 'error'
        ? SeverityNumber.ERROR
        : severity === 'warn'
          ? SeverityNumber.WARN
          : SeverityNumber.INFO,
    attributes,
    context: context.active(),
  });
  const method = severity === 'info' ? 'info' : severity === 'warn' ? 'warn' : 'error';
  const time = new Date().toISOString();
  const line = JSON.stringify({
    time,
    level: severity,
    event,
    ...attributes,
    ...traced,
  });
  // A composed line that still matches the sentinel is not written out.
  console[method](logLineCarriesPersonalData(line)
    ? JSON.stringify({ time, level: 'error', event: 'worker_fault' })
    : line);
}
