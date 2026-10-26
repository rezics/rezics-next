import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
import { createImportPipelineDriver, pipelineWork } from './pipeline-driver.ts';

const SCALES = [16, 64, 256] as const;

type Work = typeof pipelineWork;

async function importRecords(count: number): Promise<{ work: Work; committed: boolean }> {
  const directory = mkdtempSync(join(tmpdir(), 'record-cpu-growth-'));
  const driver = await createImportPipelineDriver({
    directory,
    recordConcurrency: 16,
    latencyMs: 0,
    media: 'available',
  });
  try {
    const records = Array.from({ length: count }, (_, index) => ({
      key: String(1000 + index),
      revision: 1,
      cover: true,
    }));
    Object.assign(pipelineWork, { conversions: 0, prepares: 0, statements: 0, transactions: 0 });
    const run = await driver.run(records, { collect: false });
    return {
      work: { ...pipelineWork },
      committed: run.result.status === 'committed' && run.result.counts.new === count,
    };
  } finally {
    await driver.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// Work that does not depend on the machine: converter calls, SQL statements prepared and executed,
// and commits. Processor time per record follows these counts, so a per-record rate that stays
// constant in the dump size is a processor time per record that stays constant.
test('importer processor time per record stays constant as the dump grows', async () => {
  const samples: { scale: number; work: Work }[] = [];
  for (const scale of SCALES) {
    const { work, committed } = await importRecords(scale);
    expect(committed).toBe(true);
    samples.push({ scale, work });
  }

  assertGrowth(
    samples.map(({ scale, work }): GrowthSample => ({
      scale,
      cost: { rows: work.conversions, blocks: work.prepares, statements: work.statements },
    })),
    // Conversions and statements are linear in the records; statements are prepared once, not per record.
    { rows: 'linear', blocks: 'constant', statements: 'linear' },
  );

  // Marginal work per record between the smallest and the largest dump, free of the fixed
  // per-run work (schema, ownership, the one prepare of each statement text).
  const [small, , large] = samples as [(typeof samples)[number], unknown, (typeof samples)[number]];
  const records = large.scale - small.scale;
  const perRecord = (field: keyof Work) => (large.work[field] - small.work[field]) / records;
  expect(perRecord('prepares')).toBeLessThanOrEqual(0.1);
  expect(perRecord('conversions')).toBe(5);
  expect(perRecord('transactions')).toBeLessThanOrEqual(3.1);
  expect(perRecord('statements')).toBeLessThanOrEqual(165);

  // The rate does not drift upward between the two steps either.
  const [first, second, third] = samples as [
    (typeof samples)[number],
    (typeof samples)[number],
    (typeof samples)[number],
  ];
  for (const field of ['conversions', 'transactions', 'statements'] as const) {
    const early = (second.work[field] - first.work[field]) / (second.scale - first.scale);
    const late = (third.work[field] - second.work[field]) / (third.scale - second.scale);
    expect(late).toBeLessThanOrEqual(early * 1.05);
  }
}, 120_000);
