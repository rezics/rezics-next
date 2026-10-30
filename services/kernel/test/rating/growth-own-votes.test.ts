import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { readOwnVotes } from '../../src/rating/own-votes.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import type { AccountActor, Actor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const route = 0x6a20;
const at = '2026-10-27T00:00:00.000Z';
let database: GrowthDatabase;
beforeAll(async () => {
  database = await openGrowthDatabase();
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1, ('00000000-0000-7000-8000-6a20' || lpad(to_hex(n),8,'0'))::uuid, 'actor', 'active', $2
     FROM generate_series(1,4096) n`,
    [route, newId(route)],
  );
});
afterAll(async () => {
  await database?.close();
});

function id(route: number, n: number): string {
  return `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
}

async function account(kind = 'actor'): Promise<AccountActor> {
  const accountId = newId(route);
  await database.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,$3,'active',$2)",
    [route, accountId, kind],
  );
  return {
    kind: 'account',
    accountId,
    clientId: 'own-votes',
    scopes: ['rating:vote'],
    authnEpoch: 1,
    requestedBy: null,
  };
}

async function vote(actor: AccountActor, target: string) {
  await database.admin.query(
    `INSERT INTO rating.vote(route,voter_id,question_id,target_id,units,revision,changed_at,transaction_id)
     VALUES($1,$2,$3,$4,0,1,$5,$2)`,
    [route, actor.accountId, STANDARD_QUESTION_ID, target, at],
  );
}

test('own vote batch admits empty input and rejects invalid callers and routed keys', async () => {
  const actor = await account();
  expect(await readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, [])).toEqual(new Map());
  const rejected: Actor[] = [
    { kind: 'anonymous' },
    { ...actor, scopes: [] },
    { ...actor, accountId: 'invalid' },
    { ...actor, accountId: newId(route) },
    { ...actor, authnEpoch: 0 },
    { ...actor, authnEpoch: 1.5 },
    { ...actor, authnEpoch: Number.NaN },
  ];
  for (const caller of rejected)
    await expect(readOwnVotes(database.admin, caller, STANDARD_QUESTION_ID, [])).rejects.toThrow();
  await expect(readOwnVotes(database.admin, actor, 'invalid', [])).rejects.toThrow();
  await expect(readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, ['invalid'])).rejects.toThrow();
  await expect(readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, Array<string>(1))).rejects.toThrow();
  await expect(readOwnVotes(database.admin, await account('organization'), STANDARD_QUESTION_ID, [])).rejects.toThrow();
  for (const change of ["state='suspended'", 'authn_fenced=true', 'minimum_authn_epoch=2']) {
    const actor = await account();
    if (change === "state='suspended'") await suspendAccount(database.admin, actor.accountId);
    else
      await database.admin.query(`UPDATE access.account SET ${change} WHERE route=$1 AND account_id=$2`, [
        route,
        actor.accountId,
      ]);
    await expect(readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, [])).rejects.toThrow();
  }
  const target = newId(0x7b20);
  await vote(actor, target);
  expect((await readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, Array(100).fill(target))).size).toBe(1);
  await expect(readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, Array(101).fill(target))).rejects.toThrow();
});

test('own vote batch shares the caller snapshot and keeps original target keys', async () => {
  const actor = await account();
  const target = newId(0x7b20),
    survivor = newId(0x7b20);
  await vote(actor, target);
  await database.admin.query('UPDATE rating.vote SET counted_target=$3 WHERE route=$1 AND voter_id=$2', [
    route,
    actor.accountId,
    survivor,
  ]);
  await withConnection(database.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      // Establish the caller's snapshot before changing both account admission and vote data elsewhere.
      await client.query('SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2', [route, actor.accountId]);
      await database.admin.query('UPDATE rating.vote SET units=20,revision=2 WHERE route=$1 AND voter_id=$2', [
        route,
        actor.accountId,
      ]);
      await suspendAccount(database.admin, actor.accountId);
      const result = await readOwnVotes(client, actor, STANDARD_QUESTION_ID, [survivor, target]);
      expect([...result]).toEqual([[target, { units: 0, revision: 1, at }]]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
  await expect(readOwnVotes(database.admin, actor, STANDARD_QUESTION_ID, [target])).rejects.toThrow();
});

test('own vote batch has input-bounded rows and constant statements as votes grow', async () => {
  for (const input of [1, 48, 100]) {
    const actor = await account();
    const targets = Array.from({ length: input }, () => newId(0x7b20));
    for (const target of targets) await vote(actor, target);
    const report = await checkGrowth(database, {
      name: `own vote batch input ${input}`,
      scales: [256, 1024, 4096],
      warmups: 1,
      repetitions: 2,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (db, scale, previous) =>
        seed(
          db,
          {
            name: `own vote noise ${input}`,
            hotPartition: route >>> 4,
            rows: ({ ordinal: n }) => {
              const row = {
                route,
                voter_id: actor.accountId,
                question_id: STANDARD_QUESTION_ID,
                target_id: id(0x7b20, n + 1),
                units: 10,
                revision: 1,
                changed_at: at,
                transaction_id: actor.accountId,
              };
              return {
                'rating.question': [
                  {
                    id: id(0x7100 + input, n + 1),
                    revision: 1,
                    label: 'Other question',
                    grain: 'work',
                    minimum_units: 0,
                    maximum_units: 20,
                    step_units: 1,
                  },
                ],
                'rating.vote': [
                  row,
                  { ...row, question_id: id(0x7100 + input, n + 1), target_id: targets[n % input]! },
                  { ...row, voter_id: id(route, n + 1), target_id: targets[n % input]! },
                  { ...row, route: 0x6b30, voter_id: id(0x6b30, n + input * 10000), target_id: targets[n % input]! },
                ],
              };
            },
          },
          { from: previous, to: scale },
        ),
      operation: (db) =>
        withConnection(db.pool, async (client) => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const result = await readOwnVotes(client, actor, STANDARD_QUESTION_ID, targets);
            expect(result.size).toBe(input);
            for (const target of targets) expect(result.get(target)).toEqual({ units: 0, revision: 1, at });
          } finally {
            await client.query('ROLLBACK');
          }
        }),
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(2);
      expect(cost.rows).toBeLessThanOrEqual(input + 1);
    }
    for (const metric of ['rows', 'blocks', 'statements'] as const)
      expect(report.shadow[metric].outcome).toBe('compatible');
  }
});
