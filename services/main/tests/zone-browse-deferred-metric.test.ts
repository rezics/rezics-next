import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { attributes, decode } from '../../../packages/observability/tests/otlp.ts';

type MetricSignal = { resourceMetrics: { scopeMetrics: { metrics: { name: string;
  sum?: { dataPoints: { asDouble?: number; asInt?: number;
    attributes: { key: string; value: Record<string, unknown> }[] }[] } }[] }[] }[] };

test('finding 5: the real Zone loop counts a healing retry as deferred even after earlier progress', async () => {
  const signals: MetricSignal[] = [];
  const sink = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/metrics')) {
      signals.push(decode('Metrics', new Uint8Array(await request.arrayBuffer())) as MetricSignal);
    }
    return new Response(null, { status: 200 });
  } });
  try {
    const runtime = resolve(import.meta.dir, '../../../packages/observability/src/runtime.ts');
    const support = resolve(import.meta.dir, 'relay-handoff-support.ts');
    const store = resolve(import.meta.dir, '../src/modules/zone-browse/store.ts');
    const child = Bun.spawn([process.execPath, '--eval', `
      const { startTelemetry, shutdownTelemetry } = await import(${JSON.stringify(runtime)});
      startTelemetry('zone-deferred-proof');
      const { relayHandoffFixture } = await import(${JSON.stringify(support)});
      const { ZoneBrowseProjection } = await import(${JSON.stringify(store)});
      const f = relayHandoffFixture(2);
      f.state.completeEvents.add(1); f.state.missing.add(2);
      const projection = new ZoneBrowseProjection(f.access, f.relay, f.env, 'relay');
      projection.usableCut = true;
      projection.start();
      try {
      const deadline = Date.now() + 5000;
      while (projection.recoveryStatus().state !== 'incomplete-healing') {
        if (Date.now() > deadline) throw new Error('Zone did not defer');
        await Bun.sleep(10);
      }
      await projection.stop();
      console.log(JSON.stringify(projection.recoveryStatus()));
      } finally { await projection.stop(); await shutdownTelemetry(); }
    `], { env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.origin,
      OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_TRACES_SAMPLER_ARG: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 12_000, killSignal: 'SIGKILL' });
    const [exit, output, errors] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit).toBe(0);
    expect(errors).not.toContain('worker_fault');
    expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ state: 'incomplete-healing',
      checkpoint: { sequence: '1' }, deferral: { code: 'main_relay_handoff_incomplete', retries: 1, intervalMs: 500 } });
    const runs = signals.flatMap(signal => signal.resourceMetrics).flatMap(resource => resource.scopeMetrics)
      .flatMap(scope => scope.metrics).filter(metric => metric.name === 'rezics.worker.runs')
      .flatMap(metric => metric.sum!.dataPoints).filter(point =>
        attributes(point.attributes)['rezics.worker.name'] === 'main.zone-browse.projection');
    expect(runs).toHaveLength(1);
    expect(attributes(runs[0]!.attributes)['rezics.worker.outcome']).toBe('deferred');
    expect(runs[0]!.asDouble ?? runs[0]!.asInt).toBe(1);
  } finally { await sink.stop(true); }
}, 15_000);
