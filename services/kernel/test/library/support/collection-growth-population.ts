import type { GrowthDatabase } from '../../support/growth.ts';
import { routeOf } from '../../../src/route/route.ts';

const ROWS_PER_SCALE = 1_024;
const MAX_ORDINALS_PER_BATCH = 1_000;
let nextOrdinal = 0;
let populationNamespace = 0;

type PopulationCounts = {
  accounts: number;
  collections: number;
  members: number;
  initializations: number;
  roleGrants: number;
  grants: number;
  denials: number;
  organizationMembers: number;
  inverseRows: number;
};

/** Seeds route-valid, unrelated Collection and Access rows in the same 1:8:64 population as the measured operation. */
export async function seedCollectionGrowthPopulation(
  database: GrowthDatabase,
  scale: number,
  previous: number,
  curatorId: string,
  subjectId: string,
): Promise<void> {
  const scaleDelta = scale - previous;
  if (scaleDelta <= 0) return;
  if (previous === 0) {
    // Use the UUIDv7 payload as a per-case namespace because growth database handles share the test database URL.
    populationNamespace += 1;
    if (populationNamespace > 0x0fff) throw new RangeError('Collection growth population namespace is exhausted');
    nextOrdinal = 0;
  }
  const curatorRoute = routeOf(curatorId);
  if (curatorRoute === null) throw new Error('Collection growth curator must have a native route');

  const count = scaleDelta * ROWS_PER_SCALE;
  const start = nextOrdinal;
  nextOrdinal += count;
  const actual: PopulationCounts = {
    accounts: 0,
    collections: 0,
    members: 0,
    initializations: 0,
    roleGrants: 0,
    grants: 0,
    denials: 0,
    organizationMembers: 0,
    inverseRows: 0,
  };
  let remaining = count;
  let batchStart = start;
  let batches = 0;
  while (remaining > 0) {
    const batchCount = Math.min(MAX_ORDINALS_PER_BATCH, remaining);
    const result = await database.admin.query<PopulationCounts>(
      `WITH input AS MATERIALIZED (
       SELECT $1::bigint AS start, $2::integer AS population_count, $3::integer AS curator_route,
              $4::uuid AS curator_id, $5::uuid AS subject_id, $6::integer AS namespace,
              transaction_timestamp() AS seeded_at
     ), generated AS MATERIALIZED (
       SELECT input.start + series.ordinal AS ordinal
       FROM input CROSS JOIN generate_series(1, input.population_count) AS series(ordinal)
     ), owner_routes AS MATERIALIZED (
       SELECT generated.ordinal, (generated.ordinal % 65536)::integer AS route, input.namespace
       FROM generated CROSS JOIN input
     ), other_owners AS MATERIALIZED (
       SELECT routes.ordinal, routes.route,
         ('53000000-0000-7' || lpad(to_hex(routes.namespace), 3, '0') || '-8000-' ||
          lpad(to_hex(routes.route), 4, '0') || lpad(to_hex(routes.ordinal), 8, '0'))::uuid AS curator_id,
         ('54000000-0000-7' || lpad(to_hex(routes.namespace), 3, '0') || '-8000-' ||
          lpad(to_hex(routes.route), 4, '0') || lpad(to_hex(routes.ordinal), 8, '0'))::uuid AS guest_id,
         ('51100000-0000-7' || lpad(to_hex(routes.namespace), 3, '0') || '-8000-' ||
          lpad(to_hex(routes.route), 4, '0') || lpad(to_hex(routes.ordinal), 8, '0'))::uuid AS collection_id
       FROM owner_routes routes
     ), organizations AS MATERIALIZED (
       SELECT slots.slot,
         ('55000000-0000-7' || lpad(to_hex(input.namespace), 3, '0') || '-8000-' ||
          lpad(to_hex(input.curator_route), 4, '0') ||
          lpad(to_hex(input.start * 2 + slots.slot), 8, '0'))::uuid AS organization_id
       FROM input CROSS JOIN generate_series(1, 2) AS slots(slot)
     ), collection_rows AS MATERIALIZED (
       SELECT owners.route, owners.collection_id, owners.curator_id, owners.guest_id, owners.ordinal,
              'other'::text AS population
       FROM other_owners owners
       UNION ALL
       SELECT input.curator_route,
              ('51000000-0000-7' || lpad(to_hex(input.namespace), 3, '0') || '-8000-' ||
               lpad(to_hex(input.curator_route), 4, '0') ||
               lpad(to_hex(owners.ordinal), 8, '0'))::uuid,
              input.curator_id, owners.guest_id, owners.ordinal, 'same'::text
       FROM input CROSS JOIN other_owners owners
     ), account_rows AS MATERIALIZED (
       SELECT route, curator_id AS account_id, 'actor'::text AS kind FROM other_owners
       UNION ALL
       SELECT route, guest_id, 'actor'::text FROM other_owners
       UNION ALL
       SELECT input.curator_route, organizations.organization_id, 'organization'::text
       FROM input CROSS JOIN organizations
     ), memberships AS MATERIALIZED (
       SELECT owners.route AS account_route, owners.guest_id, organizations.organization_id,
         ('56000000-0000-7' || lpad(to_hex(input.namespace), 3, '0') || '-8000-' ||
          lpad(to_hex(owners.route), 4, '0') ||
          lpad(to_hex(owners.ordinal * 2 + organizations.slot), 8, '0'))::uuid AS reservation_id,
         ('57000000-0000-7' || lpad(to_hex(input.namespace), 3, '0') || '-8000-' ||
          lpad(to_hex(owners.route), 4, '0') ||
          lpad(to_hex(owners.ordinal * 2 + organizations.slot), 8, '0'))::uuid AS source_transaction_id
       FROM other_owners owners CROSS JOIN organizations CROSS JOIN input
     ), inserted_accounts AS (
       INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch,
          membership_inverse_complete)
       SELECT rows.route, rows.account_id, rows.kind, 'active', rows.account_id, false, 1, true
       FROM account_rows rows
       RETURNING account_id
     ), inserted_collections AS (
       INSERT INTO library.collection
         (route, collection_id, curator_account_id, title, description, visibility, state, revision,
          member_count, order_epoch, created_at, updated_at, transaction_id)
       SELECT rows.route, rows.collection_id, rows.curator_id, 'Unrelated', NULL, 'private', 'active', 1,
              1, 0, input.seeded_at, input.seeded_at, rows.collection_id
       FROM collection_rows rows CROSS JOIN input
       RETURNING route, collection_id
     ), inserted_members AS (
       INSERT INTO library.collection_member
         (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
       SELECT inserted.route, inserted.collection_id,
              ((CASE rows.population WHEN 'same' THEN '52000000-0000-7' ELSE '52100000-0000-7' END) ||
               lpad(to_hex(input.namespace), 3, '0') || '-8000-' ||
               lpad(to_hex(rows.route), 4, '0') || lpad(to_hex(rows.ordinal), 8, '0'))::uuid,
              input.subject_id, NULL, 'a0000', input.seeded_at,
              ((CASE rows.population WHEN 'same' THEN '52000000-0000-7' ELSE '52100000-0000-7' END) ||
               lpad(to_hex(input.namespace), 3, '0') || '-8000-' ||
               lpad(to_hex(rows.route), 4, '0') || lpad(to_hex(rows.ordinal), 8, '0'))::uuid
       FROM inserted_collections inserted
       JOIN collection_rows rows USING (route, collection_id)
       CROSS JOIN input
       RETURNING member_id
     ), inserted_initializations AS (
       INSERT INTO access.resource_initialization (route, resource_id, resource_type, creator_id, initialized_at)
       SELECT inserted.route, inserted.collection_id, 'library.collection', rows.curator_id, input.seeded_at
       FROM inserted_collections inserted
       JOIN collection_rows rows USING (route, collection_id)
       CROSS JOIN input
       RETURNING resource_id
     ), inserted_role_grants AS (
       INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       SELECT inserted.route, inserted.collection_id, 'identity', rows.curator_id, '', 'library.collection.owner',
              tstzrange(input.seeded_at, NULL, '[)'), inserted.collection_id
       FROM inserted_collections inserted
       JOIN collection_rows rows USING (route, collection_id)
       CROSS JOIN input
       RETURNING resource_id
     ), inserted_grants AS (
       INSERT INTO access.resource_grant
         (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
       SELECT inserted.route, inserted.collection_id, 'identity', rows.guest_id, '', 'collection:read',
              tstzrange(input.seeded_at, NULL, '[)'), inserted.collection_id
       FROM inserted_collections inserted
       JOIN collection_rows rows USING (route, collection_id)
       CROSS JOIN input
       RETURNING resource_id
     ), inserted_denials AS (
       INSERT INTO access.resource_denial
         (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
       SELECT inserted.route, inserted.collection_id, rows.guest_id, '', 'collection:update', 'resource',
              tstzrange(input.seeded_at, NULL, '[)'), inserted.collection_id
       FROM inserted_collections inserted
       JOIN collection_rows rows USING (route, collection_id)
       CROSS JOIN input
       RETURNING resource_id
     ), inserted_organization_members AS (
       INSERT INTO access.organization_member
         (route, organization_id, member_account_id, role, valid, transaction_id)
       SELECT input.curator_route, memberships.organization_id, memberships.guest_id, 'member',
              tstzrange(input.seeded_at, NULL, '[)'), memberships.source_transaction_id
       FROM input CROSS JOIN memberships
       RETURNING member_account_id
     ), inserted_inverse AS (
       INSERT INTO access.membership_inverse
         (route, account_id, kind, group_id, reservation_id, transaction_id, source_transaction_id)
       SELECT memberships.account_route, memberships.guest_id, 'organization', memberships.organization_id,
              memberships.reservation_id, memberships.reservation_id, memberships.source_transaction_id
       FROM memberships
       RETURNING account_id
     )
     SELECT
       (SELECT count(*)::integer FROM inserted_accounts) AS accounts,
       (SELECT count(*)::integer FROM inserted_collections) AS collections,
       (SELECT count(*)::integer FROM inserted_members) AS members,
       (SELECT count(*)::integer FROM inserted_initializations) AS initializations,
       (SELECT count(*)::integer FROM inserted_role_grants) AS "roleGrants",
       (SELECT count(*)::integer FROM inserted_grants) AS grants,
       (SELECT count(*)::integer FROM inserted_denials) AS denials,
       (SELECT count(*)::integer FROM inserted_organization_members) AS "organizationMembers",
       (SELECT count(*)::integer FROM inserted_inverse) AS "inverseRows"`,
      [batchStart, batchCount, curatorRoute, curatorId, subjectId, populationNamespace],
    );
    const batch = result.rows[0];
    if (!batch) throw new Error('Collection growth population batch returned no counts');
    for (const key of Object.keys(actual) as (keyof PopulationCounts)[]) actual[key] += batch[key];
    remaining -= batchCount;
    batchStart += batchCount;
    batches += 1;
  }

  const expected: PopulationCounts = {
    accounts: count * 2 + batches * 2,
    collections: count * 2,
    members: count * 2,
    initializations: count * 2,
    roleGrants: count * 2,
    grants: count * 2,
    denials: count * 2,
    organizationMembers: count * 2,
    inverseRows: count * 2,
  };
  if (Object.entries(expected).some(([key, value]) => actual[key as keyof PopulationCounts] !== value))
    throw new Error(
      `Collection growth population was incomplete: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
}
