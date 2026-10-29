import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  acknowledgeErasure,
  ERASURE_PARTICIPANTS,
  readErasureStatus,
  resolveRetention,
} from '../../src/access/index.ts';
import { advanceErasureCompletion, recordLateErasureItem, resolveLateErasureItem } from '../../src/access/erasure.ts';
import { runCommand } from '../../src/command/command.ts';
import { LOCATOR_EFFECTS_QUEUE } from '../../src/work/queues.ts';
import frontierWork from '../../src/access/erasure-frontier-work.sql';
import { newId, partitionOf } from '../../src/route/route.ts';
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
    `INSERT INTO access.erasure(route,account_id,version,at,completed_at,frontier,workflow_until)
     SELECT $1,id,1,$3,$4,'[]'::jsonb,0 FROM unnest($2::uuid[]) id`,
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
        outstanding: { lateItems: false, effectsFrontier: false },
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

const lateBasis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-access',
  requestedBy: null,
};
for (const [index, phase] of (['record', 'resolve'] as const).entries()) {
  test(`late item ${phase} has constant statements and rows at three scales of unrelated accounts and late items`, async () => {
    const route = 0x4580 + index;
    const accountId = newId(route);
    const locator = 'fixed-copy-id';
    const report = await checkGrowth(db, {
      name: `late erasure item ${phase}`,
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        if (previous === 0) await accounts(database, route, [accountId], []);
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        await accounts(database, route, ids, participants);
        await database.admin.query(
          `INSERT INTO access.erasure_late_item(route,account_id,participant,locator)
          SELECT $1,id,'content','copy:'||n FROM unnest($2::uuid[]) id CROSS JOIN generate_series(1,8) n`,
          [route, ids],
        );
      },
      async operation(database) {
        // Restore the same fixture key outside the instrumented product pool for each measured run.
        await database.admin.query('DELETE FROM access.erasure_late_item WHERE route=$1 AND account_id=$2', [
          route,
          accountId,
        ]);
        if (phase === 'resolve')
          await database.admin.query(
            `INSERT INTO access.erasure_late_item(route,account_id,participant,locator)
          VALUES($1,$2,'content',$3)`,
            [route, accountId, locator],
          );
        if (phase === 'record')
          await runCommand(database.pool, { partition: partitionOf(route), basis: lateBasis }, async (tx) => {
            await recordLateErasureItem(tx, { accountId, participant: 'content', locator });
            return {
              value: null,
              events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
            };
          });
        else await resolveLateErasureItem({ pool: database.pool }, { accountId, participant: 'content', locator });
      },
    });
    expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    for (const { cost } of report.samples) {
      expect(cost.relations['access.erasure_late_item']?.sequentialScans ?? 0).toBe(0);
      expect(cost.relations['access.erasure']?.sequentialScans ?? 0).toBe(0);
    }
  }, 180000);
}

for (const [index, phase] of (['undelivered', 'locator', 'late'] as const).entries()) {
  test(`completion with ${phase} frontier stays bounded as outbox history, erasures, late items and unrelated DBOS workflows grow`, async () => {
    const route = 0x4590 + index * 16;
    const accountId = newId(route);
    const partition = partitionOf(route);
    const workflowId = `erasure-growth-held:${accountId}`;
    const explainFrontier = async () => {
      const input: Record<string, unknown> = { queue: LOCATOR_EFFECTS_QUEUE, route, account_id: accountId };
      const { rows } = await db.admin.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${frontierWork.sql}`,
        frontierWork.params.map((name) => input[name]),
      );
      return JSON.stringify(rows[0]);
    };
    const report = await checkGrowth(db, {
      name: `erasure completion ${phase}`,
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        if (previous === 0) {
          await accounts(database, route, [accountId], participants.slice(0, -1));
          await database.admin.query(
            `UPDATE access.erasure SET frontier=$3::jsonb,workflow_until=$4
            WHERE route=$1 AND account_id=$2`,
            [route, accountId, JSON.stringify([{ partition, position: '2' }]), phase !== 'undelivered' ? 1000 : null],
          );
          await database.admin.query(
            `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
            VALUES($1,'effects',1,1) ON CONFLICT(partition_no,consumer) DO UPDATE SET epoch=1,position=1`,
            [partition],
          );
          await database.admin.query(
            `INSERT INTO dbos.workflow_status(workflow_uuid,name,status,queue_name,priority,created_at)
            VALUES($1,'effect','PENDING',$2,7,10)`,
            [workflowId, LOCATOR_EFFECTS_QUEUE],
          );
        }
        if (previous === 0 && phase === 'late') {
          await database.admin.query(
            `INSERT INTO access.erasure_acknowledgement(route,account_id,participant,outcome)
            VALUES($1,$2,'delivery','none')`,
            [route, accountId],
          );
          await database.admin.query(
            `INSERT INTO access.erasure_late_item(route,account_id,participant,locator)
            VALUES($1,$2,'content','fixed-open-copy')`,
            [route, accountId],
          );
          await database.admin.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid=$1', [workflowId]);
        }
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        await accounts(database, route, ids, participants);
        await database.admin.query(
          `INSERT INTO access.erasure_late_item(route,account_id,participant,locator)
          SELECT $1,id,'content','copy:'||n FROM unnest($2::uuid[]) id CROSS JOIN generate_series(1,8) n`,
          [route, ids],
        );
        await database.admin.query(
          `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,data)
          SELECT $1,100+n,0,1,1,gen_random_uuid(),'com.rezics.subject.created.v1','{}'::jsonb
          FROM generate_series($2::integer+1,$3::integer) n`,
          [partition, previous, scale],
        );
        await database.admin.query(
          `INSERT INTO dbos.workflow_status(workflow_uuid,name,status,queue_name,priority,created_at)
          SELECT 'erasure-growth:'||$1||':'||n,'unrelated',CASE WHEN n%2=0 THEN 'ERROR' ELSE 'PENDING' END,
            'effects',n%3,1 FROM generate_series($2::integer+1,$3::integer) n`,
          [accountId, previous, scale],
        );
        // New locator work on both sides of the omitted priority column must stay outside the fixed frontier.
        await database.admin.query(
          `INSERT INTO dbos.workflow_status(workflow_uuid,name,status,queue_name,priority,created_at)
          SELECT 'erasure-newer:'||$1||':'||n,'effect','ENQUEUED',$4,(ARRAY[0,7,23])[n%3+1],100000+n
          FROM generate_series($2::integer+1,$3::integer) n`,
          [accountId, previous, scale, LOCATOR_EFFECTS_QUEUE],
        );
      },
      async operation(database) {
        expect((await advanceErasureCompletion({ pool: database.pool }, accountId)).value).toBe(false);
      },
    }).catch(async (error: unknown) => {
      // Preserve the real plan when the cost gate fails before the explicit index assertions below.
      console.error(`Erasure frontier plan (${phase}): ${await explainFrontier()}`);
      throw error;
    });
    expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    for (const { cost } of report.samples) {
      expect(cost.relations['core.outbox']?.rows ?? 0).toBe(0);
      expect(cost.relations['dbos.workflow_status']?.sequentialScans ?? 0).toBe(0);
      expect(cost.relations['access.erasure_late_item']?.sequentialScans ?? 0).toBe(0);
    }
    if (phase === 'locator') {
      // Explain the exact product SQL with its real parameters; never force an index or a planner setting.
      const plan = await explainFrontier();
      expect(plan).toContain('idx_workflow_status_in_flight_v2');
      expect(plan).not.toContain('Seq Scan');
      const searches = Array.from(plan.matchAll(/"Index Searches":(\d+)/g), (match) => Number(match[1]));
      expect(searches.length).toBeGreaterThan(0);
      expect(Math.max(...searches)).toBeLessThanOrEqual(8);
    }
    await db.admin.query(
      'DELETE FROM dbos.workflow_status WHERE workflow_uuid=$1 OR workflow_uuid LIKE $2 OR workflow_uuid LIKE $3',
      [workflowId, `erasure-growth:${accountId}:%`, `erasure-newer:${accountId}:%`],
    );
  }, 180000);
}
