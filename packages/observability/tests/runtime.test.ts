import { expect, test } from 'bun:test';
import { telemetryConfig } from '../src/config.ts';
import { attributes, decode } from './otlp.ts';

test('telemetry is opt-in by endpoint and validates ratios, protocol and headers without leaking values', () => {
  expect(telemetryConfig({}).enabled).toBe(false);
  expect(
    telemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_SDK_DISABLED: 'true',
    }).enabled,
  ).toBe(false);
  expect(telemetryConfig({ OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=a%2Cb%3Dc' }).headers).toEqual({
    'x-api-key': 'a,b=c',
  });
  expect(() => telemetryConfig({ OTEL_TRACES_SAMPLER_ARG: '1.1' })).toThrow();
  expect(() => telemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toThrow();
  expect(() => telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://example.org' })).toThrow();
  expect(() => telemetryConfig({ OTEL_EXPORTER_OTLP_HEADERS: 'PRIVATE_SECRET' })).toThrow(
    'Invalid OTEL_EXPORTER_OTLP_HEADERS',
  );
});

test('Bun exports correct HTTP spans, cumulative histograms and correlated logs, flushes on shutdown, and removes private data', async () => {
  const signals: Record<string, Record<string, any>[]> = { Traces: [], Metrics: [], Logs: [] };
  const raw: Uint8Array[] = [];
  const sink = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('content-type')).toContain('application/x-protobuf');
      expect(request.headers.get('x-probe')).toBe('local-only');
      const bytes = new Uint8Array(await request.arrayBuffer());
      raw.push(bytes);
      const signal = new URL(request.url).pathname.endsWith('/traces')
        ? 'Traces'
        : new URL(request.url).pathname.endsWith('/metrics')
          ? 'Metrics'
          : 'Logs';
      signals[signal]!.push(decode(signal, bytes));
      return new Response(null, { status: 200 });
    },
  });
  try {
    const child = Bun.spawn([process.execPath, 'packages/observability/tests/runtime-child.ts'], {
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.origin,
        OTEL_EXPORTER_OTLP_HEADERS: 'x-probe=local-only',
        OTEL_METRIC_EXPORT_INTERVAL: '1000',
        OTEL_TRACES_SAMPLER_ARG: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(
      stderr
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event),
    ).toEqual(['worker_run_failed', 'worker_run_deferred']);
    expect(stderr).not.toContain('PRIVATE_');
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.sameWorkerError).toBe(true);
    expect(result.observedValue).toBe(42);
    expect(new Set(result.workerContexts.map((item: { before: string }) => item.before)).size).toBe(
      2,
    );
    expect(
      result.workerContexts.every(
        (item: { before: string; after: string }) => item.before === item.after,
      ),
    ).toBe(true);
    expect(result.result).toEqual(
      ['11111111111111111111111111111111', '22222222222222222222222222222222'].map((id) => ({
        before: id,
        after: id,
      })),
    );
    expect(result.outbound.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(result.outbound.authorization).toBe('Bearer PRIVATE_TOKEN');
    expect(result.responses).toEqual({
      '/response': 503,
      '/mapped': 200,
      '/set': 503,
      '/throw': 500,
      '/redirect': 302,
      '/stream': 200,
      '/auth/path': 401,
      '/missing/PRIVATE_UNMATCHED': 404,
    });
    const spans = signals
      .Traces!.flatMap((r) => r.resourceSpans)
      .flatMap((r) => r.scopeSpans)
      .flatMap((r) => r.spans);
    const servers = spans.filter((s) => s.kind === 2);
    const workers = spans.filter((s) => attributes(s.attributes ?? [])['rezics.worker.name']);
    expect(workers).toHaveLength(7);
    const worker = (name: string) => workers.find((s) => s.name === name)!;
    expect(attributes(worker('main.outbox.relay').attributes)).toMatchObject({
      'rezics.worker.outcome': 'idle',
      'rezics.worker.processed': 0,
      'rezics.worker.unit': 'batch',
    });
    expect(attributes(worker('main.ranking.build').attributes)).toMatchObject({
      'rezics.worker.outcome': 'retry',
      'rezics.worker.processed': 3,
    });
    expect(attributes(worker('main.library.backfill').attributes)).toMatchObject({
      'rezics.worker.outcome': 'completed',
      'rezics.worker.trigger': 'startup',
    });
    expect(worker('main.notification.delivery').status.code).toBe(2);
    expect(attributes(worker('main.notification.delivery').attributes)['error.type']).toBe(
      'worker.execution_failed',
    );
    for (const [name, attribute] of [
      ['main.content.projection', 'db.system.name'],
      ['main.discovery.refresh', 'http.request.method'],
    ]) {
      const parent = worker(name!);
      expect(
        spans.some(
          (s) =>
            s.parentSpanId === parent.spanId &&
            s.traceId === parent.traceId &&
            attributes(s.attributes ?? [])[attribute!],
        ),
      ).toBe(true);
    }
    expect(
      spans.some((s) => attributes(s.attributes ?? [])['db.system.name'] === 'postgresql'),
    ).toBe(true);
    const expected: Record<string, number> = {
      'GET /ok/:id': 200,
      'GET /response': 503,
      'GET /mapped': 200,
      'GET /set': 503,
      'GET /throw': 500,
      'GET /redirect': 302,
      'GET /stream': 200,
      'GET /auth/*': 401,
      'GET unmatched': 404,
    };
    for (const [name, status] of Object.entries(expected)) {
      const span = servers.find((s) => s.name === name);
      expect(span).toBeDefined();
      expect(attributes(span.attributes)['http.response.status_code']).toBe(status);
      if (status >= 500) expect(span.status.code).toBe(2);
      else expect(span.status?.code ?? 0).toBe(0);
    }
    const histograms = signals
      .Metrics!.flatMap((r) => r.resourceMetrics)
      .flatMap((r) => r.scopeMetrics)
      .flatMap((r) => r.metrics)
      .filter((m) => m.name === 'http.server.request.duration');
    expect(histograms.length).toBeGreaterThan(0);
    for (const metric of histograms) {
      expect(metric.histogram.aggregationTemporality).toBe(2);
      expect(metric.exponentialHistogram).toBeUndefined();
    }
    const points = histograms.flatMap((m) => m.histogram.dataPoints);
    const workerMetrics = signals
      .Metrics!.flatMap((r) => r.resourceMetrics)
      .flatMap((r) => r.scopeMetrics)
      .flatMap((r) => r.metrics)
      .filter((m) => m.name.startsWith('rezics.worker.'));
    const workerRuns = workerMetrics
      .filter((m) => m.name === 'rezics.worker.runs')
      .flatMap((m) => m.sum.dataPoints);
    const outcomes = new Set(
      workerRuns.map((p) => attributes(p.attributes)['rezics.worker.outcome']),
    );
    expect(outcomes).toEqual(
      new Set(['worked', 'current', 'deferred', 'failed', 'idle', 'retry', 'completed']),
    );
    for (const metric of workerMetrics) {
      expect(metric.exponentialHistogram).toBeUndefined();
      expect((metric.sum ?? metric.histogram).aggregationTemporality).toBe(2);
      for (const point of (metric.sum ?? metric.histogram).dataPoints) {
        expect(
          Object.keys(attributes(point.attributes)).every((key) =>
            [
              'rezics.worker.name',
              'rezics.worker.outcome',
              'rezics.worker.trigger',
              'rezics.worker.unit',
            ].includes(key),
          ),
        ).toBe(true);
      }
    }
    expect(workerMetrics.some((m) => m.name === 'rezics.worker.duration' && m.unit === 's')).toBe(
      true,
    );
    const processed = workerMetrics
      .filter((m) => m.name === 'rezics.worker.processed')
      .flatMap((m) => m.sum.dataPoints);
    expect(
      processed.some(
        (p) =>
          attributes(p.attributes)['rezics.worker.name'] === 'main.ranking.build' &&
          String(p.asInt ?? p.asDouble) === '3',
      ),
    ).toBe(true);
    expect(points.some((p) => attributes(p.attributes)['http.response.status_code'] === 503)).toBe(
      true,
    );
    expect(points.some((p) => attributes(p.attributes)['http.response.status_code'] === 401)).toBe(
      true,
    );
    const records = signals
      .Logs!.flatMap((r) => r.resourceLogs)
      .flatMap((r) => r.scopeLogs)
      .flatMap((r) => r.logRecords);
    expect(records.filter((r) => r.body.stringValue === 'request_completed')).toHaveLength(2);
    const failure = records.find((r) => r.body.stringValue === 'worker_run_failed');
    expect(failure.traceId).toBe(worker('main.notification.delivery').traceId);
    expect(failure.spanId).toBe(worker('main.notification.delivery').spanId);
    expect(records.every((r) => r.traceId && r.spanId)).toBe(true);
    const all = raw.map((bytes) => new TextDecoder().decode(bytes)).join('');
    expect(all).not.toContain('PRIVATE_');
    expect(all).not.toContain('db.query.text');
  } finally {
    await sink.stop(true);
  }
}, 15000);

test('worker metrics and correlated errors survive zero trace sampling; disabling telemetry preserves work', async () => {
  const signals: Record<string, Record<string, any>[]> = { Traces: [], Metrics: [], Logs: [] };
  const sink = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const signal = new URL(request.url).pathname.endsWith('/traces')
        ? 'Traces'
        : new URL(request.url).pathname.endsWith('/metrics')
          ? 'Metrics'
          : 'Logs';
      signals[signal]!.push(decode(signal, new Uint8Array(await request.arrayBuffer())));
      return new Response(null, { status: 200 });
    },
  });
  try {
    for (const disabled of ['false', 'true']) {
      const child = Bun.spawn(
        [process.execPath, 'packages/observability/tests/worker-sampling-child.ts'],
        {
          env: {
            ...process.env,
            OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.origin,
            OTEL_TRACES_SAMPLER_ARG: '0',
            OTEL_SDK_DISABLED: disabled,
            OTEL_METRIC_EXPORT_INTERVAL: '1000',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ value: 42, sameError: true });
      if (disabled === 'true') expect(stderr).toBe('');
      else expect(JSON.parse(stderr).event).toBe('worker_run_failed');
    }
    expect(signals.Traces).toHaveLength(0);
    const metrics = signals
      .Metrics!.flatMap((r) => r.resourceMetrics)
      .flatMap((r) => r.scopeMetrics)
      .flatMap((r) => r.metrics);
    const runs = metrics
      .filter((m) => m.name === 'rezics.worker.runs')
      .flatMap((m) => m.sum.dataPoints);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((p) => attributes(p.attributes)['rezics.worker.outcome']))).toEqual(
      new Set(['worked', 'failed']),
    );
    const logs = signals
      .Logs!.flatMap((r) => r.resourceLogs)
      .flatMap((r) => r.scopeLogs)
      .flatMap((r) => r.logRecords);
    expect(logs).toHaveLength(1);
    expect(logs[0].traceId).toBeTruthy();
    expect(logs[0].spanId).toBeTruthy();
    expect(JSON.stringify(signals)).not.toContain('PRIVATE_');
  } finally {
    await sink.stop(true);
  }
}, 15000);
