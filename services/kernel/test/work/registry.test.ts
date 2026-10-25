import { expect, test } from 'bun:test';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { fixture } from './support/process.ts';

test('the queue set is exactly ADR-0033, with reserved governance concurrency and source partitions', () => {
  expect(Object.keys(WORK_QUEUES)).toEqual(['governance', 'effects', 'workflows', 'delivery', 'import', 'maintenance']);
  expect(WORK_QUEUES.governance.workerConcurrency).toBeGreaterThan(0);
  expect(WORK_QUEUES.import.partitionConcurrency).toBeGreaterThan(0);
});

test('queues register once before ordered modules and one launch; duplicate and late registration fail', async () => {
  const runtime = fixture('registry');
  try {
    expect(await runtime.finish()).toContain('registry-ok');
  } finally {
    runtime.child.kill();
  }
}, 30_000);
