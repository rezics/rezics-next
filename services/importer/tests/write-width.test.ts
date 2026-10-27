import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createImportPipelineDriver, type WriteSimulation } from './pipeline-driver.ts';

async function fixture(writes: WriteSimulation, count: number, recordConcurrency?: number) {
  const directory = mkdtempSync(join(import.meta.dir, '../../../.temp/write-width-'));
  const driver = await createImportPipelineDriver({
    directory,
    writes,
    ...(recordConcurrency === undefined ? {} : { recordConcurrency }),
    media: 'available',
  });
  try {
    const report = await driver.run(
      Array.from({ length: count }, (_, index) => ({
        key: String(index + 1),
        revision: 1,
        cover: true,
      })),
    );
    return { report, effects: await driver.effects() };
  } finally {
    await driver.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const simulation = (limit: number): WriteSimulation => ({ limit, attempts: [], accepted: new Map() });

test('contention answered with retryable 503 narrows the write width and every record lands once', async () => {
  const writes = simulation(3);
  const { report, effects } = await fixture(writes, 128);
  expect(report.result.status).toBe('committed');
  expect(report.result.counts.new).toBe(128);
  expect(report.records.every((record) => record.acknowledged && record.cover === 'proposed')).toBe(true);
  expect(report.acknowledgements).toHaveLength(128);
  expect(effects.subjects).toBe(128);
  expect(effects.duplicateEffects).toBe(0);
  const requestedKeys = new Set(writes.attempts.flatMap((attempt) => attempt.keys));
  expect([...writes.accepted.keys()].sort()).toEqual([...requestedKeys].sort());
  expect([...writes.accepted.values()].every((count) => count === 1)).toBe(true);
  const firstOverload = writes.attempts.findIndex((attempt) => attempt.overloaded);
  expect(firstOverload).toBeGreaterThanOrEqual(0);
  expect(writes.attempts.slice(firstOverload + 1).some((attempt) => attempt.inFlight <= 3)).toBe(true);
  expect(report.peakRecords).toBeLessThanOrEqual(16);
  expect(report.activeRequestsAtEnd).toBe(0);
});

test('a single writer that still gets retryable 503 fails the run as before', async () => {
  const writes = simulation(0);
  const { report, effects } = await fixture(writes, 1, 1);
  expect(report.result.status).toBe('bulk-failed');
  expect(writes.attempts).toHaveLength(3);
  expect(report.sleeps.map((sleep) => sleep.ms)).toEqual([1000, 2000]);
  expect(report.elapsedMs).toBeLessThanOrEqual(3100);
  expect(effects.subjects).toBe(0);
  expect(report.activeRequestsAtEnd).toBe(0);
});

test('width grows back to the configured concurrency after successful writes', async () => {
  const writes = { ...simulation(3), until: 5000 };
  const { report } = await fixture(writes, 256, 12);
  expect(report.result.status).toBe('committed');
  expect(writes.attempts.some((attempt) => attempt.overloaded)).toBe(true);
  expect(writes.attempts.some((attempt) => attempt.at >= 5000 && attempt.inFlight === 12)).toBe(true);
  expect(report.peakRecords).toBeLessThanOrEqual(12);
});
