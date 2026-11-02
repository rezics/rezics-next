import { expect, test } from 'bun:test';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { readIdentityMappings } from '../../src/semantic/identity-epoch-read.ts';
import { home, seedLegacyRoot } from './support/identity-epoch.ts';
import { isolatedDeployment, seedChain } from './support/identity-terminal-closure.ts';

// Chain size and unrelated native population are independent dimensions. These
// are real installed API calls against migrated homes, with PostgreSQL RLS.
for (const edges of [101, 205, 409]) {
  for (const population of [0, 512]) {
    test(`native closure advances bounded retained work at ${edges} edges and ${population} unrelated subjects`, async () => {
      const db = await isolatedDeployment();
      try {
        const ids = await seedChain(db, edges);
        for (let index = 0; index < population; index++) await seedLegacyRoot(db, 0x7100 + (index % 3) * 16);
        await db.install();
        const homes = [...new Set([...ids].reverse().map(home))];
        const generations = new Map<number, bigint>();
        const receipts = new Set<string>();
        let maxRows = 0, maxPoints = 0, maxStatements = 0, maxBytes = 0, maxEngineRequests = 0;
        let observed = (await readIdentityMappings(db.pool, [ids[0]!]))[0]!;
        let steps = 0;
        // A test watchdog is not a production hop cap or a guessed terminal.
        // Success requires the positive actual terminal assertion below.
        for (let round = 0; round < 2048 && observed.state !== 'mapped'; round++) {
          for (const partition of homes) {
            const progress = await stepIdentityEpochBootstrap(db.pool, partition);
            expect(progress.work.rows).toBeLessThanOrEqual(100);
            expect(progress.generation).toBeGreaterThanOrEqual(generations.get(partition) ?? 0n);
            expect(progress.native.partition).toBe(partition);
            generations.set(partition, progress.generation);
            receipts.add(progress.native.transactionId);
            maxRows = Math.max(maxRows, progress.work.rows);
            maxPoints = Math.max(maxPoints, progress.work.points);
            maxStatements = Math.max(maxStatements, progress.work.statements);
            maxBytes = Math.max(maxBytes, progress.work.bytes);
            maxEngineRequests = Math.max(maxEngineRequests, progress.work.engineRequests);
            steps++;
          }
          observed = (await readIdentityMappings(db.pool, [ids[0]!]))[0]!;
          if (observed.state === 'mapped') expect(observed.terminal).toBe(ids.at(-1)!);
        }
        expect(observed).toMatchObject({ state: 'mapped', original: ids[0], terminal: ids.at(-1) });
        expect(steps).toBeGreaterThan(1);
        expect(receipts.size).toBeGreaterThan(1);
        expect([...generations.values()].some((generation) => generation > 1n)).toBe(true);
        console.info('native terminal closure growth', JSON.stringify({
          edges, population, steps, receipts: receipts.size,
          maxRows, maxPoints, maxStatements, maxBytes, maxEngineRequests,
        }));
      } finally {
        await db.close();
      }
    });
  }
}

for (const homes of [1, 3]) {
  test(`shared suffix and ${homes}-home page crossing retain linear membership`, async () => {
    const db = await isolatedDeployment();
    try {
      const ids = await seedChain(db, 205, 0x7410, homes);
      const branches: string[] = [];
      const { historicalEdge, settle } = await import('./support/identity-terminal-closure.ts');
      for (let index = 0; index < 32; index++) {
        const branch = await seedLegacyRoot(db, 0x7410 + (index % homes) * 16);
        branches.push(branch);
        await historicalEdge(db, branch, ids[40 + index]!);
      }
      await db.install();
      const all = [...ids, ...branches];
      expect((await settle(db, all, ids[0]!, 2048)).observed).toMatchObject({
        state: 'mapped', original: ids[0], terminal: ids.at(-1),
      });
      for (const original of branches) expect((await settle(db, all, original, 2048)).observed).toMatchObject({
        state: 'mapped', original, terminal: ids.at(-1),
      });
      const memberships = (await db.admin.query(`SELECT count(*)::integer n,
        count(DISTINCT original)::integer originals FROM semantic.identity_epoch_original
        WHERE terminal=$1`, [ids.at(-1)])).rows[0]!;
      expect(memberships).toEqual({ n: all.length, originals: all.length });
      expect((await db.admin.query(`SELECT count(*)::integer n FROM semantic.identity_epoch_mapping
        WHERE original=ANY($1::uuid[])`, [all])).rows).toEqual([{ n: all.length }]);
      const ledger = (await db.admin.query(`SELECT partition_no,count(*)::integer slots,
        sum(closure_copies)::integer copies FROM semantic.identity_epoch_mapping_generation GROUP BY partition_no`)).rows;
      for (const home of ledger) {
        expect(home.slots).toBeLessThanOrEqual(4);
        expect(home.copies).toBeLessThanOrEqual(16384);
      }
    } finally { await db.close(); }
  });
}
