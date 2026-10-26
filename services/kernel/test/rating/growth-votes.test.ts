import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/permission.ts';
import type { Account } from '../../src/access/account-data.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
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
  commands = createVoteCommands({ pool: database.pool, access });
  const key = randomUUID();
  const subject = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, actorId, key),
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Book', labels: { en: 'Growth rating target' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  subjectId = subject.subject.id;
});

afterAll(async () => {
  if (database) await database.close();
});

test('putting a vote has constant rows and statements as same-partition votes grow', async () => {
  const result = await checkGrowth(database, {
    name: 'rating vote write',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDatabase, scale, previous) =>
      seed({ pool: growthDatabase.pool, admin: growthDatabase.admin }, population, { from: previous, to: scale }),
    operation: async (_growthDatabase, scale, repetition) => {
      nextUnits = (nextUnits + 1) % 21;
      return commands.putVote(
        actor,
        { questionId: STANDARD_QUESTION_ID, targetId: subjectId, units: (nextUnits + scale + repetition) % 21 },
        randomUUID(),
      );
    },
    repetitions: 1,
    warmups: 0,
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(routeOf(actorId)).toBe(route);
});
