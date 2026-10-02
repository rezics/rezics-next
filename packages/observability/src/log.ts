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
  | 'request_completed';

/** Event names and caller-selected public attributes only; never serialize Errors or request bodies. */
export function telemetryLog(
  event: TelemetryEvent,
  severity: 'info' | 'warn' | 'error' = 'info',
  attributes: Attributes = {},
) {
  const allowed = new Set([
    'operation_id',
    'causation_id',
    'graph_epoch',
    'graph_sequence',
    'index_generation',
  ]);
  attributes = Object.fromEntries(Object.entries(attributes).filter(([key]) => allowed.has(key)));
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
  console[severity === 'info' ? 'info' : severity === 'warn' ? 'warn' : 'error'](
    JSON.stringify({
      level: severity,
      event,
      ...attributes,
      ...(span?.traceId ? { trace_id: span.traceId, span_id: span.spanId } : {}),
    }),
  );
}
