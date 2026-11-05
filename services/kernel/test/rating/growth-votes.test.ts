import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/permission.ts';
import type { Account } from '../../src/access/account-data.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const route = 0x3a02;
const actorId = newId(route);
const actor: AccountActor = {
  kind: 'account',
  accountId: actorId,
  clientId: 'rating-growth-test',
  scopes: ['subject:read', 'rating:vote'],
  requestedBy: null,
  authnEpoch: 1,
};
const routeKey = new Uint8Array(32).fill(83);
let database: GrowthDatabase;
let commands: ReturnType<typeof createVoteCommands>;
let subjectId: string;
let nextUnits = 1;

function id(ordinal: number): string {
  return `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

async function createGrowthTarget(label: string): Promise<string> {
  const key = randomUUID();
  const subject = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, actorId, key),
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return subject.subject.id;
}

async function createWarmupTargets(name: string): Promise<Map<number, string>> {
  const targets = new Map<number, string>();
  for (const scale of [64, 512, 4096]) targets.set(scale, await createGrowthTarget(`${name} ${scale}`));
  return targets;
}

const population: Population = {
  name: 'rating votes',
  hotPartition: route >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => ({
    'rating.vote': [
      {
        route,
        voter_id: ordinal % 2 === 0 ? actorId : id(1_000_000 + ordinal),
        question_id: STANDARD_QUESTION_ID,
        target_id: id(2_000_000 + ordinal),
        units: ordinal % 21,
        revision: 1,
        changed_at: '2026-10-27T10:00:00.000Z',
        transaction_id: id(3_000_000 + ordinal),
      },
    ],
  }),
};

beforeAll(async () => {
  database = await openGrowthDatabase();
  await bootstrapRelease(database.pool, bundledRelease);
  await database.admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
    [route, actorId, newId(route)],
  );
  const account = (await readAccount(database.pool, route, actorId)) as Account;
  const access = createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: () => account,
  });
  commands = createVoteCommands({ pool: database.pool, access, createCommandRunner: createLibraryCommandRunner });
  subjectId = await createGrowthTarget('Growth rating target');
});

afterAll(async () => {
  if (database) await database.close();
});

test('putting a vote has constant rows and statements as same-partition votes grow', async () => {
  const warmupTargets = await createWarmupTargets('Vote write warmup');
  const result = await checkGrowth(database, {
    name: 'rating vote write',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDatabase, scale, previous) =>
      seed({ pool: growthDatabase.pool, admin: growthDatabase.admin }, population, { from: previous, to: scale }),
    warmup: async (_growthDatabase, scale, repetition) =>
      commands.putVote(
        actor,
        {
          questionId: STANDARD_QUESTION_ID,
          targetId: warmupTargets.get(scale)!,
          units: (scale + repetition) % 21,
        },
        randomUUID(),
      ),
    operation: async (_growthDatabase, scale, repetition) => {
      nextUnits = (nextUnits + 1) % 21;
      return commands.putVote(
        actor,
        { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: (nextUnits + scale + repetition) % 21 },
        randomUUID(),
      );
    },
    repetitions: 1,
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(routeOf(actorId)).toBe(route);
});

test('putting a vote reads only the capped memberships as other voters and waiting Realms grow', async () => {
  await database.admin.query(
    `INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state)
     SELECT $1, $2::uuid, ('00000000-0000-7000-8000-3a02' || lpad(to_hex(n), 8, '0'))::uuid,
            '2026-10-27T10:00:00Z', 'counted' FROM generate_series(1, 100) n`,
    [route, actorId],
  );
  const memberships: Population = {
    name: 'unrelated and uncounted memberships',
    hotPartition: route >>> 4,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'rating.voter_realm': [
        {
          route,
          voter_id: id(4_000_000 + ordinal),
          realm_id: id(5_000_000 + ordinal),
          joined_at: '2026-10-27T10:00:00Z',
          state: 'counted',
        },
        {
          route,
          voter_id: actorId,
          realm_id: id(6_000_000 + ordinal),
          joined_at: '2026-10-27T10:00:00Z',
          state: 'uncounted',
        },
      ],
    }),
  };
  let units = 0;
  const warmupTargets = await createWarmupTargets('Membership vote warmup');
  const result = await checkGrowth(database, {
    name: 'rating vote capped memberships',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) =>
      seed({ pool: db.pool, admin: db.admin }, memberships, { from: previous, to: scale }),
    warmup: async (_db, scale, repetition) =>
      commands.putVote(
        actor,
        {
          questionId: STANDARD_QUESTION_ID,
          targetId: warmupTargets.get(scale)!,
          units: (scale + repetition) % 21,
        },
        randomUUID(),
      ),
    operation: async () => {
      await commands.putVote(
        actor,
        { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: ++units },
        randomUUID(),
      );
    },
    repetitions: 1,
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  const event = (
    await database.admin.query(
      `SELECT data FROM core.outbox WHERE type = 'com.rezics.rating.vote.changed.v1' AND subject = $1
     ORDER BY position DESC LIMIT 1`,
      [actorId],
    )
  ).rows[0].data;
  expect(event.populations).toHaveLength(101);
});
