import { beforeAll, expect, test } from 'bun:test';

interface Result {
  scenario: string;
  propagatedBefore?: boolean;
  propagatedAfter: boolean;
  listenerStopped: boolean;
  poolsClosed?: boolean;
  failed: boolean;
}
let results: Result[];
beforeAll(async () => {
  const sink = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.arrayBuffer();
    return new Response(null, { status: 200 });
  } });
  try {
    const child = Bun.spawn([process.execPath, 'packages/observability/tests/telemetry-peer-lifetime-child.ts'], {
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.origin,
        OTEL_SDK_DISABLED: 'false', OTEL_TRACES_SAMPLER_ARG: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    results = JSON.parse(stdout.trim());
    expect(results).toHaveLength(18);
  } finally { await sink.stop(true); }
}, 15_000);

for (const step of ['migrate', 'matcher', 'objects', 'compose', 'backfill', 'project', 'screen-store']) {
  test(`finding 2: media ${step} failure acquires no peer registration`, () => {
    const result = results.find(item => item.scenario === `media-${step}`)!;
    expect(result.failed).toBe(true);
    expect(result.propagatedBefore).toBeUndefined();
    expect(result.propagatedAfter).toBe(false);
  });
}
for (const step of ['recovery-stop', 'main-stop', 'pool-close', 'directory-remove', 'registration-invalid', 'normal']) {
  test(`finding 2: media ${step} cleanup closes its listener and restores the peer registry`, () => {
    const result = results.find(item => item.scenario === `media-${step}`)!;
    expect(result.failed).toBe(step !== 'normal');
    if (step !== 'registration-invalid') expect(result.propagatedBefore).toBe(true);
    expect(result.propagatedAfter).toBe(false);
    expect(result.listenerStopped).toBe(true);
    expect(result.poolsClosed).toBe(true);
  });
}
for (const step of ['registration-invalid', 'registration-conflict', 'signup', 'listener-stop', 'pool-close']) {
  test(`finding 3: Account ${step} failure closes its listener and pool and restores the peer registry`, () => {
    const result = results.find(item => item.scenario === `account-${step}`)!;
    expect(result.failed).toBe(true);
    expect(result.propagatedAfter).toBe(false);
    expect(result.listenerStopped).toBe(true);
    expect(result.poolsClosed).toBe(true);
  });
}
