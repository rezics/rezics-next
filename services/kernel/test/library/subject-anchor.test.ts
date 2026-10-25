import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/permission.ts';
import type { Account } from '../../src/access/account-data.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { Access, AccountActor, Actor } from '../../src/request/access.ts';
import {
  assertGrowth,
  measure,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';
import type { Pool } from 'pg';
import { resolveSubject, readableSubjects } from '../../src/library/subject-anchor.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let pool: Pool;
let admin: pg.Pool;
let growthDatabase: GrowthDatabase;
const accountId = '019a1b2c-3d4e-7f00-8a00-beef00000001';
const actor: AccountActor = {
  kind: 'account',
  accountId,
  clientId: 'library-test',
  scopes: ['subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const anonymous: Actor = { kind: 'anonymous' };
const routeKey = new Uint8Array(32).fill(41);
const accountRoute = routeOf(accountId)!;
let account: Account;
let access: Access;

async function installAccount(targetPool: Pool, targetAdmin: pg.Pool): Promise<Account> {
  await targetAdmin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2, true)
     ON CONFLICT (route, account_id) DO NOTHING`,
    [accountRoute, accountId],
  );
  const current = await readAccount(targetPool, accountRoute, accountId);
  if (!current) throw new Error('Test account was not created');
  return current;
}

function accessFor(current: Account): Access {
  return createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: () => current,
  });
}

async function createReadableSubject(targetPool: Pool, label: string = randomUUID()): Promise<string> {
  const key = `library-subject-anchor-${randomUUID()}`;
  const result = await createSubject(targetPool, {
    actor,
    target: subjectTarget(routeKey, actor.accountId, key),
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return result.subject.id;
}

async function denyAccountRead(targetAdmin: pg.Pool, subjectId: string): Promise<void> {
  const route = routeOf(subjectId);
  if (route === null) throw new Error('Test subject must have a route');
  await targetAdmin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [route, subjectId, accountId, randomUUID()],
  );
}

beforeAll(async () => {
  growthDatabase = await openGrowthDatabase(databaseUrl);
  pool = growthDatabase.pool;
  admin = growthDatabase.admin;
  await bootstrapRelease(pool, bundledRelease);
  account = await installAccount(pool, admin);
  access = accessFor(account);
});

afterAll(async () => {
  if (growthDatabase) await growthDatabase.close();
});

test('a library write resolves an existing subject readable by the actor', async () => {
  const subjectId = await createReadableSubject(pool, 'Readable subject');

  expect(await resolveSubject({ pool, access }, actor, subjectId)).toEqual({
    subjectId,
    requestedSubjectId: null,
  });
  expect(await resolveSubject({ pool, access }, anonymous, subjectId)).toEqual({
    subjectId,
    requestedSubjectId: null,
  });
});

test('unknown, malformed, and unreadable subjects all resolve to null', async () => {
  const readableId = await createReadableSubject(pool, 'Readable subject');
  const unreadableId = await createReadableSubject(pool, 'Account denied subject');
  await denyAccountRead(admin, unreadableId);
  const unknownId = newId(routeOf(readableId)!);

  const outcomes = await Promise.all(
    [unknownId, 'not-a-subject-id', unreadableId].map((id) => resolveSubject({ pool, access }, actor, id)),
  );
  expect(outcomes).toEqual([null, null, null]);
});

test('a members page preserves input order and removes unreadable IDs and duplicates', async () => {
  const first = await createReadableSubject(pool, 'First readable subject');
  const second = await createReadableSubject(pool, 'Second readable subject');
  const unreadable = await createReadableSubject(pool, 'Unreadable subject');
  await denyAccountRead(admin, unreadable);
  const missing = newId(routeOf(first)!);

  expect(await readableSubjects({ pool, access }, actor, [second, unreadable, first, second, missing])).toEqual([
    second,
    first,
  ]);
  expect(
    await readableSubjects(
      { pool, access },
      actor,
      Array.from({ length: 100 }, () => first),
    ),
  ).toEqual([first]);
});

async function createGrowthSubject(database: GrowthDatabase): Promise<string> {
  return createReadableSubject(database.pool, `Unrelated ${randomUUID()}`);
}

test('subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow', async () => {
  const database = growthDatabase;
  const anchorId = await createReadableSubject(database.pool, 'Growth anchor');
  const unrelatedIds: string[] = [];
  const scales = [1, 8, 64] as const;
  const resolveSamples: GrowthSample[] = [];
  const pageSamples: GrowthSample[] = [];

  for (const scale of scales) {
    while (unrelatedIds.length < scale) unrelatedIds.push(await createGrowthSubject(database));

    const resolved = await measure(database, () => resolveSubject({ pool: database.pool, access }, actor, anchorId));
    expect(resolved.value).toEqual({ subjectId: anchorId, requestedSubjectId: null });
    resolveSamples.push({ scale, cost: resolved.cost });

    const pageIds = unrelatedIds.slice(0, scale);
    const page = await measure(database, () => readableSubjects({ pool: database.pool, access }, actor, pageIds));
    expect(page.value).toEqual(pageIds);
    pageSamples.push({ scale, cost: page.cost });
  }

  assertGrowth(resolveSamples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
  assertGrowth(pageSamples, { rows: 'linear', blocks: 'linear', statements: 'linear' });
}, 90_000);
