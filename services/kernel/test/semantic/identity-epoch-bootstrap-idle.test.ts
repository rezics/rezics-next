import { expect, test } from 'bun:test';
import { bootstrapFrontierHasPendingWork } from '../../src/semantic/identity-epoch-bootstrap-frontier.ts';

test('bootstrap skips only a closed topology with no dirty or unfinished home', async () => {
  let repairReads = 0;
  const readRepairHome = async (partition: number | null) => {
    repairReads++;
    return partition;
  };

  expect(await bootstrapFrontierHasPendingWork(12, () => readRepairHome(null))).toBe(true);
  expect(repairReads).toBe(0);
  expect(await bootstrapFrontierHasPendingWork(0, () => readRepairHome(null))).toBe(false);
  expect(await bootstrapFrontierHasPendingWork(0, () => readRepairHome(19))).toBe(true);
  expect(repairReads).toBe(2);
});
