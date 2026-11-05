import { expect, test } from 'bun:test';
import type { AuthErasureLiveReceiver } from '@rezics/auth-contract';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAuthErasureLiveBindings } from '../../src/access/auth-erasure-live.ts';
import { createAuthErasureObligationBindings } from '../../src/access/auth-erasure-obligations.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const deadline = () => Date.now() + 10000;

test('concurrent live arms bind one immutable receiver across independent partitions', async () => {
  const db = await openGrowthDatabase();
  try {
    const finite = createAuthErasureObligationBindings(db.pool);
    const receiver: AuthErasureLiveReceiver = {
      cutId: crypto.randomUUID(),
      authGeneration: 'restored-generation',
      databaseIdentity: 'verified-database',
      inventoryEntry: 'auth-primary',
      inventoryVersion: 'inventory-v1',
    };
    await finite.startAuthErasureObligationCut({ cutId: receiver.cutId, deadline: deadline() });
    for (const partition of [0, 1]) {
      expect(
        await finite.pageAuthErasureObligations({
          cutId: receiver.cutId,
          cursor: { partition, afterOrdinal: '0' },
          deadline: deadline(),
        }),
      ).toMatchObject({ state: 'partition-end' });
    }
    const other = { ...receiver, databaseIdentity: 'different-database' };
    const candidates = [receiver, other];
    const results = await Promise.allSettled(
      candidates.map((identity, partition) =>
        createAuthErasureLiveBindings(db.pool, identity).armAuthErasureLivePartition({
          partition,
          deadline: deadline(),
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const loser = 1 - winner;
    const refused = results[loser]!;
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(String(refused.reason)).toContain('binding changed');
    // The losing transaction must not leave an enrollment or subscription behind.
    expect((await db.admin.query('SELECT partition_no FROM access.auth_erasure_live_partition')).rows).toEqual([
      { partition_no: winner },
    ]);
    const original = { ...candidates[winner]! };
    const mutable = { ...original };
    const live = createAuthErasureLiveBindings(db.pool, mutable);
    mutable.databaseIdentity = 'mutated-after-composition';
    mutable.cutId = crypto.randomUUID();
    // Exact retry on the other partition uses the captured original identity,
    // including after an unrelated composition object has been mutated.
    expect(await live.armAuthErasureLivePartition({ partition: loser, deadline: deadline() })).toMatchObject({
      state: 'armed',
      receiver: original,
      highWater: '0',
      armHighWater: '0',
      enrolledThrough: '0',
    });
    expect(await live.verifyAuthErasureLivePartition({ partition: winner, deadline: deadline() })).toMatchObject({
      state: 'current',
      receiver: original,
    });
    const uncomposed = createAuthBindings({ pool: db.pool });
    expect(uncomposed.armAuthErasureLivePartition).toBeUndefined();
    expect(uncomposed.readAuthErasureLivePage).toBeUndefined();
    expect(uncomposed.verifyAuthErasureLivePartition).toBeUndefined();
    expect((await db.admin.query('SELECT 1 FROM access.auth_erasure_live_subscription')).rowCount).toBe(2);
    expect((await db.admin.query('SELECT 1 FROM access.erasure_acknowledgement')).rowCount).toBe(0);
  } finally {
    await db.close();
  }
}, 30000);
