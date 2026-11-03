import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { CommunityDriver, CommunityGrowth, Fixture } from '../../../../specs/community-driver.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth } from '../support/growth.ts';
import { closeCommunityDrivers, createCommunityDriver } from './community-driver.ts';

let driver: CommunityDriver;
let fixture: Fixture;
let growth: CommunityGrowth;

beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
  growth = await driver.growthFixture();
}, 120_000);

afterAll(async () => {
  await growth?.close();
  await closeCommunityDrivers();
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Record<string, unknown>;
  return [...(typeof node['Node Type'] === 'string' ? [node] : []), ...Object.values(node).flatMap(nodes)];
}

async function growHistory(scale: number, previous: number) {
  if (scale === previous) return;
  const route = routeOf(growth.realmId);
  const accountRoute = routeOf(fixture.member.id);
  if (route === null || accountRoute === null) throw new Error('Member page growth anchors are not routed');
  const ordinals = Array.from({ length: scale - previous }, (_, index) => previous + index);
  const reservations = ordinals.map(() => newId(accountRoute));
  const generations = ordinals.map(() => newId(accountRoute));
  const transactions = ordinals.map(() => newId(route));
  const values = [route, growth.realmId, fixture.member.id, fixture.owner.id, ordinals, reservations, generations, transactions];
  const range = `tstzrange('2000-01-01 00:00:00+00'::timestamptz + ordinal * interval '2 seconds',
    '2000-01-01 00:00:00+00'::timestamptz + ordinal * interval '2 seconds' + interval '1 second', '[)')`;
  await growth.database.admin.query(
    `INSERT INTO community.realm_member
       (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     SELECT $1, $2, $3, 'member', ${range}, reservation_id, transaction_id
     FROM unnest($5::integer[], $6::uuid[], $7::uuid[], $8::uuid[])
       AS sample(ordinal, reservation_id, generation_id, transaction_id)`,
    values,
  );
  await growth.database.admin.query(
    `INSERT INTO community.realm_member_terminal
       (route, realm_id, account_id, reservation_id, transaction_id, at)
     SELECT $1, $2, $3, reservation_id, transaction_id,
       '2000-01-01 00:00:00+00'::timestamptz + ordinal * interval '2 seconds' + interval '1 second'
     FROM unnest($5::integer[], $6::uuid[], $7::uuid[], $8::uuid[])
       AS sample(ordinal, reservation_id, generation_id, transaction_id)`,
    values,
  );
  await growth.database.admin.query(
    `WITH sample AS MATERIALIZED (
       SELECT ordinal, reservation_id, generation_id, transaction_id
       FROM unnest($5::integer[], $6::uuid[], $7::uuid[], $8::uuid[])
         AS sample(ordinal, reservation_id, generation_id, transaction_id)
     )
     INSERT INTO community.realm_membership_proof
       (route, realm_id, account_id, reservation_id, generation_id, operation_id, outcome,
        transaction_id, publication_transaction_id, principal_id, command_kind, command_key, at)
     SELECT $1, $2, $3, reservation_id, generation_id, 'member-page-growth-' || ordinal,
       'published', transaction_id, transaction_id, $4,
       'community.realm.membership', 'member-page-growth-' || ordinal,
       '2000-01-01 00:00:00+00'::timestamptz + ordinal * interval '2 seconds'
     FROM sample`,
    values,
  );
  await growth.database.admin.query(
    `INSERT INTO community.realm_ban
       (route, realm_id, account_id, valid, reason, actor, transaction_id)
     SELECT $1, $2, $3, ${range}, 'historical member-page ban', $4, transaction_id
     FROM unnest($5::integer[], $6::uuid[], $7::uuid[], $8::uuid[])
       AS sample(ordinal, reservation_id, generation_id, transaction_id)`,
    values,
  );
  await growth.database.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     SELECT $1, $2, 'identity', $3, '', 'community.realm.moderator', ${range}, transaction_id
     FROM unnest($5::integer[], $6::uuid[], $7::uuid[], $8::uuid[])
       AS sample(ordinal, reservation_id, generation_id, transaction_id)`,
    values,
  );
  await growth.database.admin.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
     SELECT $1, $2, 'identity', $4, '', 'realm:manage', ${range}, transaction_id
     FROM unnest($5::integer[], $6::uuid[], $7::uuid[], $8::uuid[])
       AS sample(ordinal, reservation_id, generation_id, transaction_id)`,
    values,
  );
  await growth.database.admin.query(
    'ANALYZE community.realm_member, community.realm_member_terminal, community.realm_membership_proof, community.realm_ban, access.resource_role_grant, access.resource_grant, access.account',
  );
}

test.serial(
  'the authorized member page remains bounded as unrelated homes and selected-member history grow',
  async () => {
    const path = `/v1/realms/${growth.realmId}/members?accountId=${fixture.member.id}`;
    const plans: unknown[] = [];
    const operation = async () => {
      const response = await driver.request({ actor: fixture.owner, method: 'GET', path });
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: { accountId: string }[]; selected: { accountId: string } };
      expect(page.items.map((member) => member.accountId)).toEqual([fixture.member.id]);
      expect(page.selected.accountId).toBe(fixture.member.id);
      return page;
    };
    const report = await checkGrowth(growth.database, {
      name: 'Realm member management page',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      slack: { rows: { absolute: 0, relative: 0 } },
      repetitions: 1,
      async grow(_database, scale, previous) {
        await growth.grow(scale, previous);
        await growHistory(scale, previous);
        await operation();
        plans.push((await capture(growth.database, operation)).capture.plans);
      },
      operation,
    });

    expect(report.name).toBe('Realm member management page');
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(sample.cost.statements).toBeGreaterThan(0);
    }
    const plan = nodes(plans);
    for (const index of [
      'realm_member_open',
      'realm_membership_proof_published_current',
      'realm_ban_current',
      'current_resource_role_key_pkey',
      'resource_role_grant_erasure_key_key',
      'resource_grant_point_lookup',
      'account_pkey',
    ])
      expect(plan.some((node) => node['Index Name'] === index)).toBe(true);
    for (const node of plan) {
      if (
        [
          'realm_member',
          'realm_member_terminal',
          'realm_membership_proof',
          'realm_ban',
          'current_resource_role_key',
          'current_resource_role_due',
          'resource_role_grant',
          'resource_grant',
          'account',
        ].includes(String(node['Relation Name']))
      )
        expect(node['Node Type']).not.toBe('Seq Scan');
    }
  },
  1_200_000,
);
