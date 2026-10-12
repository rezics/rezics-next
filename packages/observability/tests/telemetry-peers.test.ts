import { expect, test } from 'bun:test';
import { attributes, decode } from './otlp.ts';

test('stack peers join live classification and propagation until their last registration is undone', async () => {
  const traces: Record<string, any>[] = [];
  const sink = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/v1/traces')
        traces.push(decode('Traces', new Uint8Array(await request.arrayBuffer())));
      return new Response(null, { status: 200 });
    },
  });
  try {
    const child = Bun.spawn([process.execPath, 'packages/observability/tests/telemetry-peers-child.ts'], {
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.origin,
        OTEL_SDK_DISABLED: 'false', OTEL_TRACES_SAMPLER_ARG: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      disabledUnchanged: boolean; conflictRejected: boolean; invalidRejected: boolean;
      samples: { phase: string; service: string; port: number; traceId: string; traceparent: string | null }[];
    };
    expect(result.disabledUnchanged).toBe(true);
    expect(result.conflictRejected).toBe(true);
    expect(result.invalidRejected).toBe(true);
    const spans = traces.flatMap(batch => batch.resourceSpans)
      .flatMap(resource => resource.scopeSpans).flatMap(scope => scope.spans);
    expect(result.samples).toHaveLength(31);
    for (const sample of result.samples) {
      const parent = spans.find(span => span.name === sample.phase);
      expect(parent).toBeDefined();
      const outbound = spans.filter(span => span.parentSpanId === parent.spanId
        && attributes(span.attributes ?? [])['server.port'] === sample.port);
      expect(outbound).toHaveLength(1);
      const registered = ['registered', 'overlap', 'rejected'].includes(sample.phase)
        || sample.phase.startsWith('ACCOUNT_');
      const peer = sample.service === 'baseline' ? 'fuseki'
        : registered && ['fuseki', 'account', 'main'].includes(sample.service) ? sample.service : 'other';
      const measured = attributes(outbound[0]!.attributes ?? []);
      expect(measured['rezics.peer.service']).toBe(peer);
      if (peer !== 'other' || sample.service === 'trusted') {
        expect(sample.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
        expect(sample.traceparent!.split('-')[1]).toBe(sample.traceId);
        expect(sample.traceparent!.split('-')[2]).toBe(Buffer.from(outbound[0]!.spanId, 'base64').toString('hex'));
      } else expect(sample.traceparent).toBeNull();
      if (peer === 'fuseki') {
        expect(measured['http.request.body.size']).toBe(8);
        expect(measured['http.response.body.size']).toBeGreaterThan(0);
        expect(measured['rezics.http.body.complete']).toBe(true);
        expect(measured['rezics.fuseki.engine_ms']).toBe(7.5);
      } else expect(measured['rezics.fuseki.engine_ms']).toBeUndefined();
    }
  } finally { await sink.stop(true); }
}, 15_000);
