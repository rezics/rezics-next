import { expect, test } from 'bun:test';
import { shutdownTelemetry, startTelemetry } from '@rezics/observability/runtime';
import { workProfileProbe } from '../support/work-profile-probe.ts';
import { startWorkProfileSink } from '../support/work-profile.ts';
import {
  integrationResourceClass,
  qaResourceHeapBytes,
} from '../../../scripts/qa/resource-classes.ts';
import { planIntegrationShards } from '../../../scripts/qa/integration-shards.ts';

test('G1062: catalogue and reading files retain their own allocation after ten preceding files', () => {
  const heavy = [
    'g-1022-reading-cost',
    'g-1031-catalogue-write',
    'g-1035-catalogue-write',
    'g-1032-catalogue-preparation',
  ].map((name) => `tests/qa/integration/${name}.test.ts`);
  const preceding = Array.from(
    { length: 10 },
    (_, index) => `tests/qa/integration/preceding-${index}.test.ts`,
  );
  const plans = planIntegrationShards(
    new Map([...preceding, ...heavy].map((file) => [file, 1000])),
    1,
  );
  for (const file of heavy) {
    const plan = plans.find((plan) => plan.files.includes(file))!;
    expect(plan.files).toEqual([file]);
    expect(plan.batches).toEqual([[file]]);
    expect(plan.resourceClass).toBe(integrationResourceClass([file]));
  }
});

test('G1062: reading diagnostics use the heap of the declared resource class', () => {
  const readingClass = integrationResourceClass([
    'tests/qa/integration/g-1022-reading-cost.test.ts',
  ]);
  expect(readingClass).toBe('large-tmpfs');
  expect(qaResourceHeapBytes(readingClass)).toBe(1536 * 1024 ** 2);
  expect(qaResourceHeapBytes('ordinary')).toBe(512 * 1024 ** 2);
  expect(qaResourceHeapBytes('catalogue-disk')).toBe(1536 * 1024 ** 2);
});

test('G1062: a finite profile child still exports its own request after the parent SDK shuts down', async () => {
  const parentSink = startWorkProfileSink({ settleMs: 0 });
  try {
    startTelemetry('g-1062-parent', { ...process.env, ...parentSink.env });
    await shutdownTelemetry();
    const { result, profile } = await workProfileProbe(2);
    expect(result.account.traceparent.split('-')[1]).toBe(profile.traceId);
    expect(profile.request.status).toBe(200);
    expect(profile.fusekiRequests).toBe(2);
    expect(profile.postgresStatements).toBe(2);
    expect(parentSink.snapshot().some((span) => span.traceId === profile.traceId)).toBe(false);
  } finally {
    await shutdownTelemetry();
    await parentSink.stop();
  }
}, 15_000);
