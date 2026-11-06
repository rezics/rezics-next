import { expect, test } from 'bun:test';
import { LiveCopyPendingError } from '../../src/access/live-copy.ts';
import { readLiveCopyLineage } from '../../src/access/live-copy-lineage.ts';
import { openErasureOperationalClient } from '../../src/access/erasure-operational-client.ts';
import type { Pool } from 'pg';

test('live copy activation refuses a partition without reconciled native lineage', async () => {
  const missing = { query: async () => ({ rows: [] }) };
  await expect(readLiveCopyLineage(missing, 0)).rejects.toBeInstanceOf(LiveCopyPendingError);
  await expect(readLiveCopyLineage(missing, 0)).rejects.toThrow(
    'Live copy domain requires native lineage reconciliation before activation',
  );
  await expect(readLiveCopyLineage(missing, -1)).rejects.toBeInstanceOf(TypeError);
  const admitted = {
    query: async () => ({
      rows: [{ domain_id: 'dom', node: 'a', epoch: 1, admitted_position: '0' }],
    }),
  };
  expect(await readLiveCopyLineage(admitted, 3)).toEqual({
    partition: 3,
    domainId: 'dom',
    node: 'a',
    epoch: 1,
    admittedPosition: '0',
  });
});

test('erasure operational work requires the pool connection string', async () => {
  await expect(openErasureOperationalClient({ options: {} } as Pool)).rejects.toThrow(
    'Erasure operational work requires the pool connection string',
  );
});
