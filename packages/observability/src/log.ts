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
  'error.code',
  'rezics.backfill.examined',
  'rezics.backfill.skipped',
  'rezics.backfill.duration_ms',
]);
const counts = new Set([
  'rezics.backfill.examined',
  'rezics.backfill.skipped',
  'rezics.backfill.duration_ms',
]);
const classToken = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const codeToken = /^[A-Za-z0-9_]{1,32}$/;
const workerName = /^[a-z][a-z0-9._-]{0,63}$/;
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
    if (counts.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.trunc(value);
      continue;
    }
    if (key === 'error.class') {
      if (typeof value === 'string' && classToken.test(value) && !logLineCarriesPersonalData(value)) result[key] = value;
      continue;
    }
    if (key === 'error.code') {
      if ((typeof value === 'string' || typeof value === 'number') && codeToken.test(String(value))) {
        result[key] = String(value);
      }
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

/** The first bounded code on the error or its causes. Messages are never codes. */
function boundedCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current) {
      const raw = (current as { code?: unknown }).code;
      if ((typeof raw === 'string' || typeof raw === 'number') && codeToken.test(String(raw))) return String(raw);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** One fixed event: error class and code, never the message, stack, or row. */
export function logWorkerFault(worker: string, error: unknown): void {
  const code = boundedCode(error);
  telemetryLog('worker_fault', 'error', {
    ...(workerName.test(worker) && !logLineCarriesPersonalData(worker) ? { 'rezics.worker.name': worker } : {}),
    'error.class': boundedClass(error),
    ...(code ? { 'error.code': code } : {}),
  });
}

/** Event names and caller-selected public attributes only; never serialize Errors or request bodies. */
export function telemetryLog(
  event: TelemetryEvent,
  severity: 'info' | 'warn' | 'error' = 'info',
  attributes: Attributes = {},
) {
  attributes = publicAttributes(attributes);
  const span = trace.getSpanContext(context.active());
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
  const line = JSON.stringify({
    level: severity,
    event,
    ...attributes,
    ...(span?.traceId ? { trace_id: span.traceId, span_id: span.spanId } : {}),
  });
  // A composed line that still matches the sentinel is not written out.
  console[method](logLineCarriesPersonalData(line) ? JSON.stringify({ level: 'error', event: 'worker_fault' }) : line);
}
