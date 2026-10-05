import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
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
import { telemetryLog } from './log.ts';
import {
  fusekiEngineTime,
  fusekiCommandWork,
  commandPhases,
  commandCounters,
  requestBodyBytes,
  preserveResponseMetadata,
} from './http-measurement.ts';

const spanAttributes = new Set([
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.scheme',
  'server.address',
  'server.port',
  'http.request.body.size',
  'http.response.body.size',
  'rezics.http.body.complete',
  'rezics.http.headers_ms',
  'rezics.peer.service',
  'rezics.fuseki.engine_ms',
  ...commandPhases.map((phase) => `rezics.fuseki.${phase}_ms`),
  ...commandCounters.map((counter) => `rezics.fuseki.${counter}`),
  'db.system.name',
  'db.namespace',
  'db.operation.name',
  'error.type',
  'rezics.worker.name',
  'rezics.worker.outcome',
  'rezics.worker.trigger',
  'rezics.worker.processed',
  'rezics.worker.unit',
  'rezics.worker.oldest_pending_row_age_seconds',
  'rezics.worker.oldest_writer_age_seconds',
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
  'rezics.worker.name',
  'rezics.worker.outcome',
  'rezics.worker.trigger',
  'rezics.worker.unit',
];

/** Fixed operation names, never job, recipient, generation or resource IDs. */
export type WorkerName =
  | 'main.horizon.notification'
  | 'main.horizon.reviewRank'
  | 'main.horizon.editorial'
  | 'main.outbox.relay'
  | 'main.content.projection'
  | 'main.discovery.refresh'
  | 'main.feed.refresh'
  | 'main.ranking.build'
  | 'main.read-ranking.projection'
  | 'main.serial.projection'
  | 'main.zone-browse.projection'
  | 'main.realm-policy.recovery'
  | 'main.library-import.retention'
  | 'main.library.backfill'
  | 'main.post.backfill'
  | 'main.media.screen'
  | 'main.media.rendition'
  | 'main.verification.correction'
  | 'main.notification.producer'
  | 'main.notification.digest'
  | 'main.notification.delivery'
  | 'account.email.drain';
export interface WorkerObservation {
  oldestPendingRowAgeSeconds?: number | null;
  oldestWriterAgeSeconds?: number | null;
  outcome:
    | 'completed'
    | 'idle'
    | 'worked'
    | 'current'
    | 'deferred'
    | 'retry'
    | 'blocked'
    | 'failed';
  processed?: number;
  unit?:
    | 'event'
    | 'batch'
    | 'item'
    | 'recipient'
    | 'day'
    | 'upload'
    | 'principal'
    | 'screen'
    | 'mail';
}
const workerRun = new AsyncLocalStorage<WorkerObservation>();
let workerInstruments: ReturnType<typeof createWorkerInstruments> | undefined;

function createWorkerInstruments() {
  const meter = metrics.getMeter('rezics-workers');
  return {
    pendingAge: meter.createGauge('rezics.worker.oldest_pending_row_age', { unit: 's' }),
    writerAge: meter.createGauge('rezics.worker.oldest_writer_age', { unit: 's' }),
    runs: meter.createCounter('rezics.worker.runs', {
      description: 'Completed worker invocations.',
    }),
    processed: meter.createCounter('rezics.worker.processed', {
      description: 'Processed units, grouped by unit.',
    }),
    duration: meter.createHistogram('rezics.worker.duration', {
      unit: 's',
      description: 'Duration of a finite worker invocation, excluding its scheduled wait.',
      advice: {
        explicitBucketBoundaries: [
          0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
        ],
      },
    }),
  };
}

/** Annotate an already running job without changing its return value or scheduling. */
export function recordWorkerOutcome(observation: WorkerObservation): void {
  const run = workerRun.getStore();
  if (run) Object.assign(run, observation);
}

/** One finite invocation owns its SQL/fetch children. Metrics do not depend on trace sampling. */
export function withWorkerTelemetry<T>(
  name: WorkerName,
  work: () => Promise<T>,
  observe?: (result: T) => WorkerObservation,
  trigger: 'poll' | 'startup' = 'poll',
): Promise<T> {
  if (!telemetryEnabled()) return work();
  const { runs, processed, duration, pendingAge, writerAge } = (workerInstruments ??= createWorkerInstruments());
  const attributes = { 'rezics.worker.name': name, 'rezics.worker.trigger': trigger };
  return trace
    .getTracer('rezics-workers')
    .startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, (span) =>
      workerRun.run({ outcome: 'completed' }, async () => {
        const run = workerRun.getStore()!;
        const started = performance.now();
        try {
          const result = await work();
          // Observation must never turn a successful business operation into a failure.
          try {
            if (observe) {
              const next = observe(result);
              Object.assign(run, next, {
                outcome: run.outcome === 'completed' ? next.outcome : run.outcome,
              });
            }
          } catch {
            /* retain the recorded result */
          }
          if (run.outcome === 'retry' || run.outcome === 'blocked' || run.outcome === 'failed') {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute('error.type', `worker.${run.outcome}`);
            telemetryLog('worker_run_deferred', 'warn', {
              ...attributes,
              'rezics.worker.outcome': run.outcome,
            });
          }
          return result;
        } catch (error) {
          run.outcome = 'failed';
          // Exception messages/names may contain private provider or database data.
          span.setAttribute('error.type', 'worker.execution_failed');
          span.setStatus({ code: SpanStatusCode.ERROR });
          telemetryLog('worker_run_failed', 'error', {
            ...attributes,
            'rezics.worker.outcome': run.outcome,
          });
          throw error;
        } finally {
          const labels = { ...attributes, 'rezics.worker.outcome': run.outcome };
          span.setAttributes(labels);
          runs.add(1, labels);
          duration.record((performance.now() - started) / 1000, labels);
          if (run.unit && Number.isSafeInteger(run.processed) && run.processed! >= 0) {
            span.setAttribute('rezics.worker.processed', run.processed!);
            span.setAttribute('rezics.worker.unit', run.unit);
            processed.add(run.processed!, { ...labels, 'rezics.worker.unit': run.unit });
          }
          for (const [value, instrument, attribute] of [
            [run.oldestPendingRowAgeSeconds, pendingAge, 'rezics.worker.oldest_pending_row_age_seconds'],
            [run.oldestWriterAgeSeconds, writerAge, 'rezics.worker.oldest_writer_age_seconds'],
          ] as const) {
            if (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
              instrument.record(value ?? 0, attributes);
              if (value !== null) span.setAttribute(attribute, value);
            }
          }
          span.end();
        }
      }),
    );
}

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
let traceProcessor: BatchSpanProcessor | undefined;
export function telemetryEnabled() {
  return sdk !== undefined;
}

/** Bun's fetch is not Undici. Fuseki body counts follow the consumer's pulls. */
export function instrumentFetch(
  origins: ReadonlySet<string>,
  exporterOrigin: string,
  peers: ReadonlyMap<string, 'fuseki' | 'account' | 'main'> = new Map(),
) {
  const original = globalThis.fetch;
  const wrapped: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === exporterOrigin) return original(input, init);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const peer = peers.get(url.origin) ?? 'other';
      return trace.getTracer('rezics-fetch').startActiveSpan(
        `HTTP ${method}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'http.request.method': method,
            'server.address': url.hostname,
            'server.port': Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
            'url.scheme': url.protocol.slice(0, -1),
            'rezics.peer.service': peer,
          },
        },
        async (span) => {
          const started = performance.now();
          let streaming = false;
          try {
            const sentBytes = requestBodyBytes(input, init);
            if (peer === 'fuseki' && sentBytes !== undefined)
              span.setAttribute('http.request.body.size', sentBytes);
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
            span.setAttribute('rezics.http.headers_ms', performance.now() - started);
            span.setAttribute('http.response.status_code', response.status);
            if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
            if (peer === 'fuseki') {
              span.setAttributes(fusekiCommandWork(response.headers));
              const engineMs = fusekiEngineTime(response.headers);
              if (engineMs !== undefined) span.setAttribute('rezics.fuseki.engine_ms', engineMs);
              if (!response.body) {
                span.setAttribute('http.response.body.size', 0);
                span.setAttribute('rezics.http.body.complete', true);
              } else {
                // Pull with the consumer: no clone/tee, buffering or eager drain.
                const reader = response.body.getReader();
                let bytes = 0;
                let ended = false;
                const end = (complete: boolean) => {
                  if (ended) return;
                  ended = true;
                  span.setAttribute('http.response.body.size', bytes);
                  span.setAttribute('rezics.http.body.complete', complete);
                  span.end();
                };
                const body = new ReadableStream<Uint8Array>(
                  {
                    async pull(controller) {
                      try {
                        const next = await reader.read();
                        if (next.done) {
                          end(true);
                          controller.close();
                        } else {
                          bytes += next.value.byteLength;
                          controller.enqueue(next.value);
                        }
                      } catch (error) {
                        span.setAttribute('error.type', 'http.body_failed');
                        span.setStatus({ code: SpanStatusCode.ERROR });
                        end(false);
                        controller.error(error);
                      }
                    },
                    async cancel(reason) {
                      end(false);
                      await reader.cancel(reason);
                    },
                  },
                  { highWaterMark: 0 },
                );
                streaming = true;
                return preserveResponseMetadata(response, new Response(body, response));
              }
            }
            return response;
          } catch (error) {
            span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            if (!streaming) span.end();
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
  traceProcessor = processor;
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
  const peers = new Map<string, 'fuseki' | 'account' | 'main'>();
  if (env.FUSEKI_URL) peers.set(new URL(env.FUSEKI_URL).origin, 'fuseki');
  for (const name of ['ACCOUNT_JWKS_URL', 'ACCOUNT_INTROSPECT_URL', 'ACCOUNT_ORIGIN'] as const)
    if (env[name]) peers.set(new URL(env[name]!).origin, 'account');
  if (env.MAIN_ORIGIN) peers.set(new URL(env.MAIN_ORIGIN).origin, 'main');
  restoreFetch = instrumentFetch(config.propagationOrigins, new URL(base).origin, peers);
  process.once('beforeExit', () => {
    void shutdownTelemetry();
  });
}

/** QA can drain request traces without shutting down a shared in-process app. */
export function flushTelemetryTraces(): Promise<void> {
  return traceProcessor?.forceFlush() ?? Promise.resolve();
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
