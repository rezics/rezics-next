import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRealmMembership } from '../../src/community/membership.ts';
import { readAccount } from '../../src/access/account-data.ts';
import type { LifecycleRequest } from '../../src/access/lifecycle.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { createProductionAccess, type ProductionAccess } from './membership-fixture.ts';

const actions = ['realm:join', 'realm:manage', 'realm:participate', 'realm:read', 'realm:publish', 'access:grant'];
const scopes = [...actions];
const probeRoute = 0x2130;
const opened = '[2020-01-01 00:00:00+00,)';
const at = '2026-10-26T00:00:00.000Z';
const scales = [256, 1024, 4096] as [number, number, number];

let db: GrowthDatabase;
let membership: ReturnType<typeof createRealmMembership>;
let production: ProductionAccess;
let requests: LifecycleRequest[] = [];
let managerId: string;
let probe: {
  realmId: string;
  route: number;
  memberId: string;
  memberReservationId: string;
  memberTransactionId: string;
  terminalAccountId: string;
  terminalReservationId: string;
  terminalTransactionId: string;
};
let candidates: { accountId: string; reservationId: string }[];

/** One request per publish, authenticated by Access just before it runs. */
async function authenticatedRequest(): Promise<LifecycleRequest> {
  const account = await withConnection(db.pool, (client) => readAccount(client, probeRoute, managerId));
  if (!account) throw new Error('Missing manager');
  return {
    actor: await production.authenticate(db.pool, managerId, scopes),
    account,
    deadline: Date.now() + 60_000,
  };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 10;
  db.pool.options.connectionTimeoutMillis = 10_000;
  const route = probeRoute;
  const realmId = newId(route);
  const spaceId = newId(route);
  const spaceRevision = newId(route);
  const realmRevision = newId(route);
  managerId = newId(route);
  const memberId = newId(0x2140);
  const terminalAccountId = newId(0x2150);
  const memberReservationId = newId(routeOf(memberId)!);
  const memberTransactionId = newId(route);
  const terminalReservationId = newId(routeOf(terminalAccountId)!);
  const terminalTransactionId = newId(route);
  const created = '2020-01-01 00:00:00+00';
  for (const id of [managerId, memberId, terminalAccountId]) {
    await db.admin.query(
      "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  }
  const connection = await db.admin.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      `INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1,$2,'active',$3,$4,$5)`,
      [route, spaceId, spaceRevision, created, managerId],
    );
    await connection.query(
      `INSERT INTO community.space_revision (route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1,$2,$3,NULL,'Host','',$4,$5)`,
      [route, spaceId, spaceRevision, created, managerId],
    );
    await connection.query(
      `INSERT INTO community.realm
         (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1,$2,$3,'active','protected',$4,$5,$6,$7)`,
      [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevision, created, managerId],
    );
    await connection.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1,$2,$3,NULL,'Realm','','protected',$4,$5,$6)`,
      [route, realmId, realmRevision, GLOBAL_CONTEXT, created, managerId],
    );
    await connection.query(
      `INSERT INTO community.realm_member
         (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
       VALUES ($1,$2,$3,'member',$4::tstzrange,$5,$6)`,
      [route, realmId, memberId, opened, memberReservationId, memberTransactionId],
    );
    await connection.query(
      `INSERT INTO community.realm_member_terminal
         (route, realm_id, account_id, reservation_id, transaction_id, at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [route, realmId, terminalAccountId, terminalReservationId, terminalTransactionId, created],
    );
    await connection.query(
      `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
       VALUES ($1,$2,$3,'realm:manage','(,)',$3)`,
      [route, realmId, managerId],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] = async () => null;
  // Production composition: only the authenticator's own actors are admitted.
  production = await createProductionAccess({
    actions,
    realmRoleReader: (client, input) => roleReader(client, input),
  });
  membership = createRealmMembership({ deadlineNow: () => Date.now(), pool: db.pool, access: production.access });
  roleReader = membership.roleReader;
  probe = {
    realmId,
    route,
    memberId,
    memberReservationId,
    memberTransactionId,
    terminalAccountId,
    terminalReservationId,
    terminalTransactionId,
  };
  candidates = [];
  for (let index = 0; index < 24; index++) {
    const accountId = newId(0x2160);
    await db.admin.query(
      "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(accountId), accountId],
    );
    candidates.push({ accountId, reservationId: newId(0x2160) });
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

test('publish, terminal reads and role proofs stay within their bound as Realms and members grow', async () => {
  const hotPartition = partitionOf(probe.route);
  const base = Number(
    (await db.admin.query('SELECT position FROM core.partition WHERE partition_no = $1', [hotPartition])).rows[0]
      .position,
  );
  const population: Population = {
    name: 'realm-membership-neighbours',
    hotPartition,
    hotShare: 1,
    rows({ route, ordinal }) {
      const spaceId = newId(route);
      const realmId = newId(route);
      const revisionId = newId(route);
      const accountId = newId(route);
      const reservationId = newId(route);
      const terminalReservationId = newId(route);
      const transactionId = crypto.randomUUID();
      const position = base + ordinal * 100 + 1;
      const value = { realmId, accountId };
      return {
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: revisionId,
            created_at: '2020-01-01 00:00:00+00',
            creator: accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: revisionId,
            predecessor: null,
            title: 'Neighbour',
            summary: '',
            created_at: '2020-01-01 00:00:00+00',
            author: accountId,
          },
        ],
        'community.realm': [
          {
            route,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: revisionId,
            created_at: '2020-01-01 00:00:00+00',
            creator: accountId,
          },
        ],
        'community.realm_revision': [
          {
            route,
            realm_id: realmId,
            revision_id: revisionId,
            predecessor: null,
            title: 'Neighbour',
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: '2020-01-01 00:00:00+00',
            author: accountId,
          },
        ],
        'access.account': [{ route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: accountId }],
        'community.realm_member': [
          {
            route,
            realm_id: realmId,
            account_id: accountId,
            role: 'member',
            valid: opened,
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'community.realm_member_terminal': [
          {
            route,
            realm_id: realmId,
            account_id: accountId,
            reservation_id: terminalReservationId,
            transaction_id: transactionId,
            at: '2020-01-01 00:00:00+00',
          },
        ],
        'access.membership_inverse': [
          {
            route,
            account_id: accountId,
            kind: 'realm',
            group_id: realmId,
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: '',
            action: 'realm:manage',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: '',
            grant_role: 'community.realm.owner',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_denial': [
          {
            route,
            resource_id: realmId,
            subject_id: accountId,
            subject_role: '',
            action: 'realm:manage',
            reason: 'resource',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_kind: 'account',
            principal_id: accountId,
            command_kind: 'community.realm.membership',
            idempotency_key: `seed-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position,
            transaction_id: transactionId,
            response: value,
          },
        ],
        'core.outbox': [
          {
            partition_no: hotPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: crypto.randomUUID(),
            type: 'com.rezics.community.realm.membership.v1',
            subject: realmId,
            data: value,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: hotPartition,
            transaction_id: transactionId,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: accountId,
            client_id: 'realm-membership',
            requested_by: null,
            recorded_at: '2020-01-01 00:00:00+00',
          },
        ],
      };
    },
    async finish(admin) {
      await admin.query(
        'UPDATE core.partition SET position = (SELECT max(position) FROM core.outbox WHERE partition_no = $1) WHERE partition_no = $1',
        [hotPartition],
      );
    },
  };
  const principal = { kind: 'realm' as const, id: probe.realmId };
  const report = await checkGrowth(db, {
    name: 'Realm membership publish, terminal reads and role proofs',
    scales,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_database, scale, previous) {
      await seed(db, population, { from: previous, to: scale });
      requests = await Promise.all(candidates.map(() => authenticatedRequest()));
    },
    async operation(_database, _scale, repetition) {
      const candidate = candidates[repetition];
      if (!candidate) throw new Error(`Missing candidate ${repetition}`);
      const published = await membership.publish(
        { ...requests[repetition]!, deadline: Date.now() + 60_000 },
        {
          kind: 'membership',
          principal,
          memberAccountId: candidate.accountId,
          role: 'member',
          authorization: `authenticated-fixture.${candidate.accountId}`,
        },
        { accountId: candidate.accountId, principal, reservationId: candidate.reservationId },
        `growth-publish-${repetition}`,
      );
      expect(published.replayed).toBe(false);
      expect(published.value).toMatchObject({
        realmId: probe.realmId,
        accountId: candidate.accountId,
        reservationId: candidate.reservationId,
        role: 'member',
      });
      const [terminal, change, proofs] = await withConnection(db.pool, async (client) => {
        const terminalRow = await membership.authority.readTerminal(client, {
          accountId: probe.terminalAccountId,
          principal,
          reservationId: probe.terminalReservationId,
        });
        const changeRow = await membership.authority.readChange(client, {
          accountId: probe.memberId,
          principal,
          key: 'growth-change',
          sourceTransactionId: probe.memberTransactionId,
        });
        const proofRows = await membership.roleReader(client, {
          realmId: probe.realmId,
          accountId: probe.memberId,
          at,
        });
        return [terminalRow, changeRow, proofRows] as const;
      });
      expect(terminal).toEqual({
        accountId: probe.terminalAccountId,
        principal,
        reservationId: probe.terminalReservationId,
        transactionId: probe.terminalTransactionId,
      });
      expect(change).toEqual({
        accountId: probe.memberId,
        principal,
        key: 'growth-change',
        sourceTransactionId: probe.memberTransactionId,
        reservationId: probe.memberReservationId,
      });
      expect(proofs?.map((proof) => proof.role)).toEqual(['owner', 'member']);
      expect(proofs?.find((proof) => proof.role === 'member')?.member).toBe(true);
      expect(proofs?.find((proof) => proof.role === 'owner')?.member).toBe(false);
      return published;
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual(scales);
  expect(new Set(report.samples.map((sample) => sample.cost.statements)).size).toBe(1);
  for (const sample of report.samples) {
    const relations = Object.entries(sample.cost.relations ?? {});
    expect(relations.length).toBeGreaterThan(0);
    for (const [, cost] of relations) expect(cost.sequentialScans).toBe(0);
  }
}, 600_000);
