import { profileRequest, startWorkProfileSink } from './work-profile.ts';

/** Calibrate exported counters with real client calls, including deliberately repeated work. */
export async function workProfileProbe(loops: number, real = false) {
  const sink = startWorkProfileSink({ settleMs: 25 });
  try {
    const measured = await profileRequest(
      sink,
      async (headers) => {
        const child = Bun.spawn(
          [process.execPath, 'packages/observability/tests/work-profile-child.ts'],
          {
            env: {
              ...process.env,
              ...sink.env,
              WORK_PROFILE_REAL: real ? '1' : '0',
              WORK_PROFILE_LOOPS: String(loops),
              WORK_PROFILE_TRACEPARENT: headers.get('traceparent')!,
              OTEL_SERVICE_NAME: 'main',
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
        if (code !== 0) throw new Error(`Work profile probe failed (${code}): ${stderr}`);
        return JSON.parse(stdout.trim()) as {
          rows: string[];
          account: { traceparent: string };
          totalLatencyMs: number;
        };
      },
      { service: 'main' },
    );
    // Exclude child startup, pool close and SDK shutdown from the request's wall time.
    measured.profile.totalLatencyMs = measured.result.totalLatencyMs;
    return measured;
  } finally {
    await sink.stop();
  }
}
