import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  acknowledgeErasure,
  ERASURE_PARTICIPANTS,
  readErasureStatus,
  resolveRetention,
} from '../../src/access/index.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const participants = ERASURE_PARTICIPANTS[1];
const at = new Date();
const completedAt = new Date(at.getTime() + 1000);
const scales: [number, number, number] = [256, 1024, 4096];
const retainedExceptions = Array.from({ length: 16 }, (_, i) => ({
  store: `evidence_${i}`,
  fields: ['decision', 'reporter'],
  purpose: 'Moderation appeal',
  expiresAt: new Date(at.getTime() + 1).toISOString(),
})).sort((a, b) => a.store.localeCompare(b.store));
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function accounts(
  database: GrowthDatabase,
  route: number,
  ids: string[],
  acknowledged: readonly string[],
  retained = false,
  retainedParticipant = 'content',
) {
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
    `INSERT INTO access.erasure_acknowledgement(route,account_id,participant,outcome,retained)
     SELECT $1,id,participant,CASE WHEN $4 AND participant=$6 THEN 'erased' ELSE 'none' END,
     CASE WHEN $4 AND participant=$6 THEN $5::jsonb ELSE '[]'::jsonb END FROM unnest($2::uuid[]) id CROSS JOIN unnest($3::text[]) participant`,
    [route, ids, acknowledged, retained, JSON.stringify(retainedExceptions), retainedParticipant],
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
            phase === 'repeat',
            'delivery',
          );
        const ids = Array.from({ length: (scale - previous) * 4 }, () => newId(route));
        await accounts(database, route, ids, participants, true);
      },
      async operation(database) {
        const accountId = targets[next++];
        if (!accountId) throw new Error('Erasure growth fixture exhausted');
        await acknowledgeErasure(
          { pool: database.pool, clock: () => completedAt },
          {
            accountId,
            participant: participants.at(-1)!,
            outcome: 'erased',
            retained: retainedExceptions.map((entry) => ({ ...entry, expiresAt: new Date(entry.expiresAt) })),
          },
        );
        // Assertions use the uninstrumented admin pool, outside measured product reads.
        const stored = await readErasureStatus(database.admin, accountId);
        expect(stored?.participants.delivery).toEqual({
          outcome: 'erased',
          retained: retainedExceptions.map((entry) => ({
            ...entry,
            resolvedAt: null,
            overdue: true,
          })),
        });
        expect(stored?.state).toBe(phase === 'pending' ? 'pending' : 'retention-outstanding');
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
      if (previous === 0) await accounts(database, route, [accountId], participants, true);
      await accounts(
        database,
        route,
        Array.from({ length: (scale - previous) * 4 }, () => newId(route)),
        participants,
        true,
      );
    },
    async operation(database) {
      expect(await readErasureStatus(database.pool, accountId)).toEqual({
        version: 1,
        at: at.toISOString(),
        state: 'retention-outstanding',
        participants: Object.fromEntries(
          participants.map((id) => [
            id,
            id === 'content'
              ? {
                  outcome: 'erased',
                  retained: retainedExceptions.map((entry) => ({
                    ...entry,
                    resolvedAt: null,
                    overdue: true,
                  })),
                }
              : { outcome: 'none', retained: [] },
          ]),
        ),
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

for (const [index, phase] of (['initial', 'repeat'] as const).entries()) {
  test(`retention resolution (${phase}) stays constant as accounts, erasures and other accounts' exceptions grow at three scales`, async () => {
    const route = 0x4564 + index;
    const targets = Array.from({ length: 18 }, () => newId(route));
    let next = 0;
    const report = await checkGrowth(db, {
      name: `retention resolution ${phase}`,
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        if (previous === 0) {
          await accounts(database, route, targets, participants, true);
          if (phase === 'repeat')
            await database.admin.query(
              `UPDATE access.erasure_acknowledgement
            SET resolutions=jsonb_build_object('evidence_0', $3::timestamptz)
            WHERE route=$1 AND account_id=ANY($2::uuid[]) AND participant='content'`,
              [route, targets, completedAt],
            );
        }
        await accounts(
          database,
          route,
          Array.from({ length: (scale - previous) * 4 }, () => newId(route)),
          participants,
          true,
        );
      },
      async operation(database) {
        const accountId = targets[next++];
        if (!accountId) throw new Error('Retention growth fixture exhausted');
        await resolveRetention(
          { pool: database.pool, clock: () => completedAt },
          { accountId, participant: 'content', store: 'evidence_0' },
        );
        const stored = await readErasureStatus(database.admin, accountId);
        expect(stored?.state).toBe('retention-outstanding');
        expect(stored?.completedAt).toBe(completedAt.toISOString());
        expect(stored?.participants.content!.retained.filter((entry) => entry.resolvedAt !== null)).toEqual([
          { ...retainedExceptions[0]!, resolvedAt: completedAt.toISOString(), overdue: false },
        ]);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
    expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
    expect(new Set(report.samples.map((sample) => sample.cost.rows)).size).toBe(1);
    for (const { cost } of report.samples) {
      expect(cost.relations?.['access.erasure_acknowledgement']?.sequentialScans).toBe(0);
      expect(cost.relations?.['access.erasure_acknowledgement']?.rows).toBeLessThanOrEqual(3);
    }
  }, 180000);
}
