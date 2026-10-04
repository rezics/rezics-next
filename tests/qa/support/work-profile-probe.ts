import { profileRequest, startWorkProfileSink } from './work-profile.ts';
import { runWorkProfileChild } from './work-profile-child.ts';

/** Calibrate exported counters with real client calls, including deliberately repeated work. */
export async function workProfileProbe(loops: number, real = false) {
  if (!Number.isSafeInteger(loops) || loops < 1 || loops > 100)
    throw new Error('Work profile calibration requires 1..100 loops');
  const sink = startWorkProfileSink({ settleMs: 25 });
  try {
    const measured = await profileRequest(
      sink,
      async (headers) => {
        const { stdout } = await runWorkProfileChild(
          'packages/observability/tests/work-profile-child.ts',
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
          },
        );
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
