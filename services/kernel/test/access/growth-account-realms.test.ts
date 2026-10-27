import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRealmMembership } from '../../src/community/membership.ts';
import { readAccountRealms } from '../../src/access/account-realms.ts';
import type { Access, AccessRealmRoleReader, AccountActor } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const accountRoute = 0x6250;
const realmRoute = 0x6251;
const target = id(accountRoute, 1);
const other = id(accountRoute, 2);
const reader = id(accountRoute, 3);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(53)]]) };
const actions = new Map([['realm:read', { anonymous: true }]]);
let db: GrowthDatabase;
let access: Access;
let realmRoleReader: AccessRealmRoleReader = async () => null;
let viewer: Promise<AccountActor> | undefined;

function id(route: number, suffix: number): string {
  return `00000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${suffix.toString(16).padStart(8, '0')}`;
}

function realmFacts(index: number, growth: boolean) {
  const start = growth ? 0x10000000 + index * 4 : index * 4;
  return {
    realm: id(realmRoute, start + 1),
    space: id(realmRoute, start + 2),
    spaceRevision: id(realmRoute, start + 3),
    revision: id(realmRoute, start + 4),
    context: id(0x6252, start + 1),
  };
}

async function seedRealms(database: GrowthDatabase, facts: ReturnType<typeof realmFacts>[]): Promise<void> {
  if (facts.length === 0) return;
  const admin = await database.admin.connect();
  const createdAt = new Date(Date.now() - 60_000);
  try {
    await admin.query('BEGIN');
    await admin.query('SET CONSTRAINTS ALL DEFERRED');
    await admin.query(
      `INSERT INTO community.space(route, space_id, state, head_revision_id, created_at, creator)
       SELECT $1, space_id, 'active', revision_id, $2, $3
       FROM unnest($4::uuid[], $5::uuid[]) AS rows(space_id, revision_id)`,
      [realmRoute, createdAt, target, facts.map(({ space }) => space), facts.map(({ spaceRevision }) => spaceRevision)],
    );
    await admin.query(
      `INSERT INTO community.space_revision(route, space_id, revision_id, predecessor, title, summary, created_at, author)
       SELECT $1, space_id, revision_id, NULL, 'Growth Account Realms Space', '', $2, $3
       FROM unnest($4::uuid[], $5::uuid[]) AS rows(space_id, revision_id)`,
      [realmRoute, createdAt, target, facts.map(({ space }) => space), facts.map(({ spaceRevision }) => spaceRevision)],
    );
    await admin.query(
      `INSERT INTO community.realm(route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       SELECT $1, realm_id, space_id, 'active', 'protected', context_id, revision_id, $2, $3
       FROM unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[]) AS rows(realm_id, space_id, context_id, revision_id)`,
      [
        realmRoute,
        createdAt,
        target,
        facts.map(({ realm }) => realm),
        facts.map(({ space }) => space),
        facts.map(({ context }) => context),
        facts.map(({ revision }) => revision),
      ],
    );
    await admin.query(
      `INSERT INTO community.realm_revision(route, realm_id, revision_id, predecessor, title, summary, visibility,
       context_id, created_at, author)
       SELECT $1, realm_id, revision_id, NULL, 'Growth Account Realms Realm', '', 'protected', context_id, $2, $3
       FROM unnest($4::uuid[], $5::uuid[], $6::uuid[]) AS rows(realm_id, revision_id, context_id)`,
      [
        realmRoute,
        createdAt,
        target,
        facts.map(({ realm }) => realm),
        facts.map(({ revision }) => revision),
        facts.map(({ context }) => context),
      ],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  } finally {
    admin.release();
  }
}

async function seedMemberships(database: GrowthDatabase, facts: ReturnType<typeof realmFacts>[]): Promise<void> {
  if (facts.length === 0) return;
  const realms = facts.map(({ realm }) => realm);
  const admin = database.admin;
  await admin.query(
    `INSERT INTO community.realm_member(route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     SELECT $1, realm_id, account_id, 'member', tstzrange($4::timestamptz, NULL, '[)'), gen_random_uuid(), gen_random_uuid()
     FROM unnest($2::uuid[]) AS groups(realm_id) CROSS JOIN unnest($3::uuid[]) AS accounts(account_id)`,
    [realmRoute, realms, [target, other], new Date(Date.now() - 30_000)],
  );
  await admin.query(
    `INSERT INTO access.membership_inverse(route, account_id, kind, group_id, reservation_id, transaction_id)
     SELECT $1, account_id, 'realm', realm_id, gen_random_uuid(), gen_random_uuid()
     FROM unnest($2::uuid[]) AS accounts(account_id)
     CROSS JOIN unnest($3::uuid[]) AS groups(realm_id)`,
    [accountRoute, [target, other], realms],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  let roleReader: AccessRealmRoleReader = async () => null;
  access = admittedAccess({ actions, realmRoleReader: (client, input) => roleReader(client, input) });
  realmRoleReader = createRealmMembership({ pool: db.pool, access }).roleReader;
  roleReader = realmRoleReader;
});
afterAll(async () => db?.close());

test("account Realm pages stay bounded as this and other accounts' memberships grow at a fixed limit", async () => {
  const report = await checkGrowth(db, {
    name: 'account Realm page',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route, account_id, kind, state, transaction_id, public_views,
             membership_inverse_complete)
           SELECT $1, account_id, 'actor', 'active', account_id,
             '{"posts":true,"reviews":true,"collections":true,"realms":true}'::jsonb, true
           FROM unnest($2::uuid[]) AS accounts(account_id)`,
          [accountRoute, [target, other, reader]],
        );
        const initial = Array.from({ length: 21 }, (_, index) => realmFacts(index, false));
        await seedRealms(database, initial);
        await seedMemberships(database, initial);
        await database.admin.query(
          `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
           SELECT $1, realm_id, $2, 'realm:read', '(,)', realm_id
           FROM unnest($3::uuid[]) AS realms(realm_id)`,
          [realmRoute, reader, initial.map(({ realm }) => realm)],
        );
      }
      const growth = Array.from({ length: scale - previous }, (_, index) => realmFacts(previous + index, true));
      await seedRealms(database, growth);
      await seedMemberships(database, growth);
    },
    async operation(database) {
      viewer ??= authenticateAccount(
        access,
        { pool: database.pool, deadline: Date.now() + 30_000 },
        { accountId: reader, clientId: 'account-realms-growth', scopes: ['realm:read'] },
      );
      const result = await readAccountRealms(
        { pool: database.pool, tokens, access, realmRoleReader },
        await viewer,
        target,
        new Date(),
        Date.now() + 30_000,
        { limit: 20 },
      );
      expect(result.realms).toHaveLength(20);
      expect(result.next).toBeString();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) expect(sample.cost.relations?.['access.membership_inverse']?.rows).toBe(21);
}, 120_000);
