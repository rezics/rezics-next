import { Elysia } from 'elysia';
import { opentelemetry } from '@elysia/opentelemetry';
import { telemetryEnabled } from './runtime.ts';

/** Install before all routes, including mounted Better Auth responses. */
export function httpTelemetry() {
  if (!telemetryEnabled()) return new Elysia({ name: 'rezics-telemetry-disabled' });
  return opentelemetry({
    recordBody: false,
    headersToSpanAttributes: { request: [], response: [] },
  });
}
