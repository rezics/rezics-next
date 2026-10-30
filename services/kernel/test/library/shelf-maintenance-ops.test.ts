import { expect, test } from 'bun:test';
import { createShelfMaintenanceDerivedPorts } from '../../src/library/shelf-maintenance-ops-contract.ts';
import {
  validateShelfMaintenanceBinding,
  validateShelfMaintenanceCursor,
} from '../../src/library/shelf-maintenance-runtime.ts';
import type { ShelfDerivedPage } from '../../src/library/shelf-maintenance-ops-contract.ts';
import { newId } from '../../src/route/route.ts';

test('maintenance locators retain bigint decimals and closed numeric budgets without granting derived authority', async () => {
  const owner = { route: 0x6a10, accountId: newId(0x6a10) };
  validateShelfMaintenanceBinding({
    ...owner,
    runId: newId(owner.route),
    epoch: '9007199254740993',
    sequence: '100',
    segment: 1,
  });
  expect(() => validateShelfMaintenanceCursor([Number.MAX_SAFE_INTEGER + 1])).toThrow();
  expect(() => validateShelfMaintenanceCursor(Array(9).fill(null))).toThrow();
  expect(() => validateShelfMaintenanceCursor(['x'.repeat(2049)])).toThrow();
  expect(() =>
    validateShelfMaintenanceBinding({ ...owner, runId: newId(owner.route), epoch: '01', sequence: '0', segment: 0 }),
  ).toThrow();
  const copied = { owner, runId: newId(owner.route), epoch: 1n, generationId: newId(owner.route) } as ShelfDerivedPage;
  // A pool/query lookalike and a structural TS brand cannot mint a live native page.
  await expect(
    createShelfMaintenanceDerivedPorts().continue(
      {
        query: async () => {
          throw new Error('must not query');
        },
      } as never,
      copied,
      newId(owner.route),
    ),
  ).rejects.toThrow('No live native shelf derived page');
});
