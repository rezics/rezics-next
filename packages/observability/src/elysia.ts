import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { opentelemetry } from '@elysia/opentelemetry';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { telemetryEnabled } from './runtime.ts';

function requestTracerReady(): boolean {
  const provider = trace.getTracerProvider();
  if (!('getDelegateTracer' in provider) || typeof provider.getDelegateTracer !== 'function') return true;
  return provider.getDelegateTracer('rezics-http') != null;
}

/** The SDK starts only when an exporter is configured, and this plugin used to
 * install nothing in that case, so a request had no active span. Register the
 * context manager and a tracer with no processors first: calling the plugin
 * alone would start NodeSDK, which exports by default and propagates baggage.
 */
function ensureRequestContext(): void {
  if (telemetryEnabled() || requestTracerReady()) return;
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  // Baggage can carry private data; propagate the W3C trace parent only.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [] }));
}

/** Install before all routes, including mounted Better Auth responses. */
export function httpTelemetry() {
  ensureRequestContext();
  return opentelemetry({
    recordBody: false,
    headersToSpanAttributes: { request: [], response: [] },
  });
}
