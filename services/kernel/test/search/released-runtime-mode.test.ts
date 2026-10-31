import { expect, test } from 'bun:test';
import { releasedDiscoveryRuntime } from './support/released-discovery-runtime.ts';

test('explicit kernelPool selects instrumentation and refuses process crash/restart before acquiring resources', async () => {
  const previous = process.env.OPENSEARCH_URL;
  // No service is installed or started. An attempted engine connection must fail.
  process.env.OPENSEARCH_URL = 'http://127.0.0.1:1';
  let poolCalls = 0;
  const instrumented = releasedDiscoveryRuntime(() => {
    poolCalls += 1;
    throw new Error('An unstarted composition must not acquire a pool');
  });
  const child = releasedDiscoveryRuntime();
  try {
    expect(instrumented.control.workerKind).toBe('in-process');
    expect(child.control.workerKind).toBe('owned-child');
    for (const control of ['crash', 'restart'] as const) {
      await expect(instrumented.control[control]()).rejects.toThrow('explicit kernelPool capability');
      await expect(child.control[control]()).rejects.toThrow('has not started');
    }
    expect(poolCalls).toBe(0);
    const closing = instrumented.close();
    expect(instrumented.close()).toBe(closing);
    await closing;
    await expect(instrumented.control.crash()).rejects.toThrow('explicit kernelPool capability');
    expect(poolCalls).toBe(0);
  } finally {
    await Promise.all([instrumented.close(), child.close()]);
    if (previous === undefined) delete process.env.OPENSEARCH_URL;
    else process.env.OPENSEARCH_URL = previous;
  }
});
