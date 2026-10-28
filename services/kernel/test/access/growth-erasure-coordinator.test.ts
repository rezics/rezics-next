import { afterAll, beforeAll, expect, test } from 'bun:test';
import { acknowledgeErasure, ERASURE_PARTICIPANTS, readErasureStatus } from '../../src/access/index.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const participants = ERASURE_PARTICIPANTS[1];
const at = new Date();
const completedAt = new Date(at.getTime() + 1000);
const scales: [number, number, number] = [256, 1024, 4096];
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function accounts(database: GrowthDatabase, route: number, ids: string[], acknowledged: readonly string[]) {
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1,id,'actor','deleted',id FROM unnest($2::uuid[]) id`,
    [route, ids],
  );
  await database.admin.query(
    `INSERT INTO access.erasure(route,account_id,version,at,completed_at)
     SELECT $1,id,1,$3,$4 FROM unnest($2::uuid[]) id`,
    [route, ids, at, acknowledged.length === participants.length ? completedAt : null],
  );
  await database.admin.query(
    `INSERT INTO access.erasure_acknowledgement(route,account_id,participant,outcome)
     SELECT $1,id,participant,'none' FROM unnest($2::uuid[]) id CROSS JOIN unnest($3::text[]) participant`,
    [route, ids, acknowledged],
  );
}

for (const [index, phase] of (['pending', 'complete', 'repeat'] as const).entries()) {
  test(`erasure acknowledgement (${phase}) stays constant as accounts and completed erasures grow at three scales`, async () => {
    const route = 0x4560 + index;
    const targets = Array.from({ length: 18 }, () => newId(route));
    let next = 0;
    const report = await checkGrowth(db, {
      name: `erasure acknowledgement ${phase}`,
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        if (previous === 0)
          await accounts(
            database,
            route,
            targets,
            phase === 'pending' ? [] : phase === 'complete' ? participants.slice(0, -1) : participants,
          );
        const ids = Array.from({ length: (scale - previous) * 4 }, () => newId(route));
        await accounts(database, route, ids, participants);
      },
      async operation(database) {
        const accountId = targets[next++];
        if (!accountId) throw new Error('Erasure growth fixture exhausted');
        await acknowledgeErasure(
          { pool: database.pool, clock: () => completedAt },
          {
            accountId,
            participant: participants.at(-1)!,
            outcome: 'none',
          },
        );
        // Assertions use the uninstrumented admin pool, outside measured product reads.
        const stored = await readErasureStatus(database.admin, accountId);
        expect(stored?.participants.delivery).toBe('none');
        expect(stored?.completedAt).toBe(phase === 'pending' ? null : completedAt.toISOString());
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
    expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
    for (const { cost } of report.samples) {
      expect(cost.relations?.['access.erasure']?.sequentialScans ?? 0).toBe(0);
      expect(cost.relations?.['access.erasure_acknowledgement']?.sequentialScans ?? 0).toBe(0);
      expect(cost.relations?.['access.erasure_acknowledgement']?.rows ?? 0).toBeLessThanOrEqual(
        2 * participants.length,
      );
    }
  }, 180000);
}

test('erasure status costs one point read and at most P outcomes as accounts and completed erasures grow at three scales', async () => {
  const route = 0x4563;
  const accountId = newId(route);
  const report = await checkGrowth(db, {
    name: 'erasure status read',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0) await accounts(database, route, [accountId], participants);
      await accounts(
        database,
        route,
        Array.from({ length: (scale - previous) * 4 }, () => newId(route)),
        participants,
      );
    },
    async operation(database) {
      expect(await readErasureStatus(database.pool, accountId)).toEqual({
        version: 1,
        at: at.toISOString(),
        participants: Object.fromEntries(participants.map((id) => [id, 'none'])),
        completedAt: completedAt.toISOString(),
      });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(1);
    expect(cost.relations?.['access.erasure']?.rows).toBe(1);
    expect(cost.relations?.['access.erasure_acknowledgement']?.rows).toBe(participants.length);
    expect(cost.relations?.['access.erasure']?.sequentialScans).toBe(0);
    expect(cost.relations?.['access.erasure_acknowledgement']?.sequentialScans).toBe(0);
  }
}, 180000);
