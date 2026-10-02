import { randomUUID } from 'node:crypto';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  createAllowListAttributesProcessor,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { telemetryConfig } from './config.ts';

const spanAttributes = new Set([
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.scheme',
  'server.address',
  'server.port',
  'db.system.name',
  'db.namespace',
  'db.operation.name',
  'error.type',
]);
const metricAttributes = [
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.scheme',
  'server.address',
  'server.port',
  'db.system.name',
  'db.namespace',
  'db.operation.name',
  'state',
  'error.type',
];

/** Sanitize the exported copy, after all lifecycle hooks have finished. */
export function safeSpan(span: ReadableSpan): ReadableSpan {
  const attributes = Object.fromEntries(
    Object.entries(span.attributes).filter(([key]) => spanAttributes.has(key)),
  );
  return {
    ...span,
    spanContext: () => ({ ...span.spanContext(), traceState: undefined }),
    attributes,
    name:
      span.kind === SpanKind.SERVER
        ? `${attributes['http.request.method'] ?? 'HTTP'} ${attributes['http.route'] ?? 'unmatched'}`
        : span.name,
    status: { code: span.status.code },
    events: [],
    links: span.links.map((link) => ({
      ...link,
      context: { ...link.context, traceState: undefined },
      attributes: {},
    })),
  };
}

export function safeTraceExporter(exporter: SpanExporter): SpanExporter {
  return {
    export: (spans, callback) => exporter.export(spans.map(safeSpan), callback),
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  };
}

let sdk: NodeSDK | undefined;
let stopPromise: Promise<void> | undefined;
let restoreFetch: (() => void) | undefined;
export function telemetryEnabled() {
  return sdk !== undefined;
}

/** Bun's fetch is not Undici. Capture headers latency without reading/consuming the body. */
export function instrumentFetch(origins: ReadonlySet<string>, exporterOrigin: string) {
  const original = globalThis.fetch;
  const wrapped: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === exporterOrigin) return original(input, init);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      return trace.getTracer('rezics-fetch').startActiveSpan(
        `HTTP ${method}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'http.request.method': method,
            'server.address': url.hostname,
            'server.port': Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
            'url.scheme': url.protocol.slice(0, -1),
          },
        },
        async (span) => {
          try {
            let options = init;
            if (origins.has(url.origin)) {
              const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
              );
              const carrier: Record<string, string> = {};
              propagation.inject(context.active(), carrier);
              for (const [name, value] of Object.entries(carrier)) headers.set(name, value);
              options = { ...init, headers };
            }
            const response = await original(input, options);
            span.setAttribute('http.response.status_code', response.status);
            if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
            return response;
          } catch (error) {
            span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },
    { preconnect: original.preconnect },
  );
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

/** Called by Bun --preload, before pg and application modules are imported. */
export function startTelemetry(
  serviceName: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (sdk) return;
  const config = telemetryConfig(env);
  if (!config.enabled) return;
  const base = config.OTEL_EXPORTER_OTLP_ENDPOINT!.replace(/\/$/, '');
  const instanceAttribute = config.OTEL_RESOURCE_ATTRIBUTES.split(',').find((value) =>
    value.trim().startsWith('service.instance.id='),
  );
  const instanceId = instanceAttribute?.trim().slice('service.instance.id='.length);
  const exporter = { headers: config.headers, timeoutMillis: config.OTEL_EXPORTER_OTLP_TIMEOUT };
  const metricTimeout = Math.min(
    config.OTEL_EXPORTER_OTLP_TIMEOUT,
    config.OTEL_METRIC_EXPORT_INTERVAL,
  );
  const processor = new BatchSpanProcessor(
    safeTraceExporter(new OTLPTraceExporter({ ...exporter, url: `${base}/v1/traces` })),
    {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: config.OTEL_EXPORTER_OTLP_TIMEOUT,
    },
  );
  sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': config.OTEL_SERVICE_NAME ?? serviceName,
      'service.namespace': 'rezics',
      'service.version': config.OTEL_SERVICE_VERSION,
      'service.instance.id': instanceId || randomUUID(),
      'deployment.environment.name': config.OTEL_DEPLOYMENT_ENVIRONMENT,
      'process.runtime.name': 'bun',
      'process.runtime.version': Bun.version,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.OTEL_TRACES_SAMPLER_ARG),
    }),
    textMapPropagator: new W3CTraceContextPropagator(), // Baggage can carry private data; never propagate it.
    spanProcessors: [processor],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          ...exporter,
          timeoutMillis: metricTimeout,
          url: `${base}/v1/metrics`,
          temporalityPreference: AggregationTemporality.CUMULATIVE,
        }),
        exportIntervalMillis: config.OTEL_METRIC_EXPORT_INTERVAL,
        exportTimeoutMillis: metricTimeout,
      }),
    ],
    views: [
      {
        instrumentName: '*',
        attributesProcessors: [createAllowListAttributesProcessor(metricAttributes)],
        aggregationCardinalityLimit: 2000,
      },
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ ...exporter, url: `${base}/v1/logs` }),
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 1000,
        exportTimeoutMillis: config.OTEL_EXPORTER_OTLP_TIMEOUT,
      }),
    ],
    instrumentations: [
      new PgInstrumentation({
        enhancedDatabaseReporting: false,
        requireParentSpan: true,
        ignoreConnectSpans: true,
        addSqlCommenterCommentToQueries: false,
      }),
    ],
  });
  sdk.start();
  // Internal owner calls may carry W3C context; credentials, query text and paths are never recorded.
  for (const name of ['FUSEKI_URL', 'ACCOUNT_JWKS_URL', 'ACCOUNT_INTROSPECT_URL'] as const) {
    if (env[name]) config.propagationOrigins.add(new URL(env[name]!).origin);
  }
  restoreFetch = instrumentFetch(config.propagationOrigins, new URL(base).origin);
  process.once('beforeExit', () => {
    void shutdownTelemetry();
  });
}

export function withTelemetrySpan<T>(name: string, work: () => Promise<T>): Promise<T> {
  return trace.getTracer('rezics-jobs').startActiveSpan(name, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Invoke after requests, jobs and database pools have drained. Idempotent and bounded. */
export function shutdownTelemetry(): Promise<void> {
  if (stopPromise) return stopPromise;
  if (!sdk) return Promise.resolve();
  restoreFetch?.();
  const shuttingDown = sdk.shutdown();
  stopPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 6000);
    void shuttingDown
      .catch(() => {
        console.error('Telemetry shutdown failed');
      })
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
  return stopPromise;
}
