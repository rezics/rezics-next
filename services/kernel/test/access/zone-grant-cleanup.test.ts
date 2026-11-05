import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  minimizeZoneGrantPage,
  type ZoneGrantCleanupAdmission,
  type ZoneGrantCleanupCursor,
  type ZoneGrantCleanupSource,
  type ZonePrimaryOwnerEvidence,
  type ZoneCleanupBranchEvidence,
} from '../../src/access/zone-grant-cleanup.ts';
import { runCommand } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import { lockZoneHead, type ZoneHead } from '../../src/zones/resource-store.ts';
import { installResourceRoleCatalogue, resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { resourceFixture } from '../zones/resource-fixture.ts';

let f: Awaited<ReturnType<typeof resourceFixture>>;
let grantPool: Pool;
let grantCommands: ReturnType<typeof createGrantCommands>;
let parallelGrantCommands: ReturnType<typeof createGrantCommands>;
let grantAccess: Access;
let parallelGrantAccess: Access;
const fixtureActions = [
  'access:grant',
  'account:delete',
  'zone:create',
  'zone:read',
  'zone:configure',
  'zone:publish',
  'zone:delete',
  'zone:restore',
  'zone:purge',
] as const;

beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
  grantPool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
  const declared = actionDeclarations(fixtureActions);
  grantAccess = f.access.access({ actions: declared, clock: f.clock });
  parallelGrantAccess = f.access.access({ actions: declared, clock: f.clock });
  installResourceRoleCatalogue(grantAccess, resolveResourceRoles(declared));
  installResourceRoleCatalogue(parallelGrantAccess, resolveResourceRoles(declared));
  grantCommands = createGrantCommands({
    pool: f.db.pool,
    access: grantAccess,
    managementAction: 'access:grant',
    clock: f.clock,
  });
  parallelGrantCommands = createGrantCommands({
    pool: grantPool,
    access: parallelGrantAccess,
    managementAction: 'access:grant',
    clock: f.clock,
  });
}, 120_000);

afterAll(async () => {
  await grantPool?.end();
  await f?.close();
});

async function commandContext(pool: Pool, access: NonNullable<typeof grantAccess>, persona: 'owner' | 'other') {
  const boundary = { pool, deadline: Date.now() + 30_000 };
  return { ...boundary, actor: await access.authenticate(f.access.bearer(persona), boundary) };
}

async function readOnly<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const client = await f.db.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function sourceFrom(head: ZoneHead, homeEpoch: string): ZoneGrantCleanupSource {
  return {
    zone: {
      route: head.route,
      zoneId: head.id,
      home: { partition: partitionOf(head.route), epoch: homeEpoch },
    },
    revision: head.revision,
    lifecycleRevision: head.lifecycleRevision,
    // The Access cursor binds these values; Semantic supplies its admitted cleanup values.
    generation: head.lifecycleRevision,
    progress: head.revision,
    protectionRevision: head.lifecycleRevision,
  };
}

function dispositionAdmission(source: ZoneGrantCleanupSource): ZoneGrantCleanupAdmission {
  return {
    kind: 'zone-disposition',
    branch: 'early-privacy',
    source,
    branchEvidence: {} as ZoneCleanupBranchEvidence,
  } as unknown as ZoneGrantCleanupAdmission;
}

function terminalAdmission(
  source: ZoneGrantCleanupSource,
  accountId: string,
  barrier: { version: string; at: string },
  primaryOwner: ZonePrimaryOwnerEvidence,
): ZoneGrantCleanupAdmission {
  return {
    kind: 'terminal-account-subject',
    branch: 'terminal-account',
    source,
    accountId,
    barrier,
    primaryOwner,
  } as unknown as ZoneGrantCleanupAdmission;
}

async function withZonePage(
  zoneId: string,
  cursor: ZoneGrantCleanupCursor | null,
  limit: number,
  makeAdmission: (head: ZoneHead, source: ZoneGrantCleanupSource) => ZoneGrantCleanupAdmission,
) {
  const route = routeOf(zoneId)!;
  return (
    await runCommand(
      f.db.pool,
      { partition: partitionOf(route), deadline: Date.now() + 30_000, clock: f.clock },
      async (tx) => {
        const head = await lockZoneHead(tx, route, zoneId);
        if (!head) throw new Error('Fixture Zone disappeared');
        const home = await tx.query<{ epoch: string }>(
          'SELECT epoch::text FROM core.partition WHERE partition_no=$1',
          [partitionOf(route)],
        );
        const source = sourceFrom(head, home.rows[0]!.epoch);
        const admission = makeAdmission(head, source);
        const page = await minimizeZoneGrantPage(tx, { admission, cursor, limit });
        return { value: { admission, page }, events: [] };
      },
    )
  ).value;
}

async function rollbackZonePage(
  zoneId: string,
  limit: number,
  makeAdmission: (head: ZoneHead, source: ZoneGrantCleanupSource) => ZoneGrantCleanupAdmission,
) {
  const route = routeOf(zoneId)!;
  await expect(
    runCommand(
      f.db.pool,
      { partition: partitionOf(route), deadline: Date.now() + 30_000, clock: f.clock },
      async (tx) => {
        const head = await lockZoneHead(tx, route, zoneId);
        if (!head) throw new Error('Fixture Zone disappeared');
        const home = await tx.query<{ epoch: string }>(
          'SELECT epoch::text FROM core.partition WHERE partition_no=$1',
          [partitionOf(route)],
        );
        await minimizeZoneGrantPage(tx, {
          admission: makeAdmission(head, sourceFrom(head, home.rows[0]!.epoch)),
          cursor: null,
          limit,
        });
        throw new Error('rollback Zone grant page');
      },
    ),
  ).rejects.toThrow('rollback Zone grant page');
}

async function addActionGrant(
  zoneId: string,
  accountId: string,
  actions: readonly string[],
  actor: 'owner' | 'other' = 'owner',
) {
  const pool = actor === 'owner' ? f.db.pool : grantPool;
  const access = actor === 'owner' ? grantAccess : parallelGrantAccess;
  const commands = actor === 'owner' ? grantCommands : parallelGrantCommands;
  const context = await commandContext(pool, access, actor);
  const route = routeOf(zoneId)!;
  return commands.create(context, {
    resource: { route, id: zoneId },
    subjectId: accountId,
    subjectRole: '',
    actions,
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  });
}

async function addOwnerRole(zoneId: string, accountId: string) {
  const context = await commandContext(f.db.pool, grantAccess, 'owner');
  return grantCommands.createRole(context, {
    resource: { route: routeOf(zoneId)!, id: zoneId },
    subject: { kind: 'account', id: accountId },
    role: 'semantic.zone.owner',
    valid: '(,)',
    key: Bun.randomUUIDv7(),
  });
}

async function drain(
  zoneId: string,
  makeAdmission: (head: ZoneHead, source: ZoneGrantCleanupSource) => ZoneGrantCleanupAdmission,
  cursor: ZoneGrantCleanupCursor | null,
) {
  for (let i = 0; i < 32; i++) {
    const result = await withZonePage(zoneId, cursor, 1, makeAdmission);
    if (result.page.disposition === 'complete') return result;
    cursor = result.page.next;
    if (!cursor) throw new Error('Incomplete Zone grant page has no continuation');
  }
  throw new Error('Bounded Zone grant cleanup did not converge');
}

test('Zone disposition pages bind the Zone CAS and leave another resource untouched', async () => {
  const zone = await f.create();
  const otherZone = await f.create();
  await addActionGrant(zone.id, f.accounts.owner, ['zone:read']);
  await addActionGrant(zone.id, f.accounts.editor, ['zone:configure']);
  await addActionGrant(zone.id, f.accounts.other, ['zone:read']);
  await addActionGrant(otherZone.id, f.accounts.owner, ['zone:read']);
  const route = routeOf(zone.id)!;
  const selectedResourceKeys = await readOnly<{ erasure_key: string }>(
    'SELECT erasure_key::text FROM access.resource_grant WHERE route=$1 AND resource_id=$2 ORDER BY erasure_key',
    [route, zone.id],
  );
  const selectedRoleKeys = await readOnly<{ erasure_key: string }>(
    'SELECT erasure_key::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 ORDER BY erasure_key',
    [route, zone.id],
  );
  expect(selectedResourceKeys.length).toBeGreaterThan(1);
  expect(selectedRoleKeys.length).toBeGreaterThan(0);

  const mode = (_head: ZoneHead, source: ZoneGrantCleanupSource) => dispositionAdmission(source);
  await rollbackZonePage(zone.id, 1, mode);
  const afterRollback = await readOnly<{ n: number }>(
    'SELECT count(*)::integer AS n FROM access.resource_grant WHERE route=$1 AND resource_id=$2',
    [route, zone.id],
  );
  expect(afterRollback[0]!.n).toBe(selectedResourceKeys.length);

  const first = await withZonePage(zone.id, null, 1, mode);
  expect(first.page).toMatchObject({ disposition: 'progress', candidateKeys: 2, processedKeys: 1 });
  const unrelated = await withZonePage(otherZone.id, first.page.next, 1, mode);
  expect(unrelated.page).toMatchObject({ disposition: 'rebound', candidateKeys: 0, removedRows: 0 });

  const publish = await f.call(
    'owner',
    'POST',
    `/v1/zones/${zone.id}:publish`,
    { visibility: 'unlisted' },
    f.conditional('1'),
  );
  expect(publish.status).toBe(200);
  const stale = await withZonePage(zone.id, first.page.next, 1, mode);
  expect(stale.page).toMatchObject({ disposition: 'rebound', candidateKeys: 0, removedRows: 0 });

  await drain(zone.id, mode, stale.page.next);
  const remainingResourceKeys = await readOnly<{ erasure_key: string }>(
    'SELECT erasure_key::text FROM access.resource_grant WHERE erasure_key=ANY($1::bigint[])',
    [selectedResourceKeys.map((row) => row.erasure_key)],
  );
  const remainingRoleKeys = await readOnly<{ erasure_key: string }>(
    'SELECT erasure_key::text FROM access.resource_role_grant WHERE erasure_key=ANY($1::bigint[])',
    [selectedRoleKeys.map((row) => row.erasure_key)],
  );
  expect(remainingResourceKeys).toEqual([]);
  expect(remainingRoleKeys).toEqual([]);
  const otherRows = await readOnly<{ n: number }>(
    'SELECT count(*)::integer AS n FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
    [routeOf(otherZone.id), otherZone.id, f.accounts.owner],
  );
  expect(otherRows[0]!.n).toBe(1);
});

test('terminal account pages remove only its Zone subject grants and close interleaved additions', async () => {
  const zone = await f.create();
  const otherZone = await f.create();
  await addOwnerRole(zone.id, f.accounts.other);
  await addActionGrant(zone.id, f.accounts.owner, ['zone:read']);
  await addActionGrant(zone.id, f.accounts.editor, ['zone:configure']);
  await addActionGrant(zone.id, f.accounts.other, ['zone:read']);
  await addActionGrant(otherZone.id, f.accounts.owner, ['zone:read']);

  const race = await Promise.allSettled([
    f.tombstoneOwner(),
    addActionGrant(zone.id, f.accounts.owner, ['zone:read'], 'other'),
  ]);
  expect(race[0]!.status).toBe('fulfilled');
  if (race[1]!.status === 'rejected') expect(race[1]!.reason).toBeInstanceOf(GrantDeniedError);

  const ownerRoute = routeOf(f.accounts.owner)!;
  const barriers = await readOnly<{ version: string; at: string }>(
    'SELECT version::text,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
    [ownerRoute, f.accounts.owner],
  );
  expect(barriers).toHaveLength(1);
  const subjectResourceKeys = await readOnly<{ erasure_key: string }>(
    `SELECT erasure_key::text FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3 AND subject_role=''`,
    [routeOf(zone.id), zone.id, f.accounts.owner],
  );
  const subjectRoleKeys = await readOnly<{ erasure_key: string }>(
    `SELECT erasure_key::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3 AND subject_role=''`,
    [routeOf(zone.id), zone.id, f.accounts.owner],
  );
  expect(subjectResourceKeys.length).toBeGreaterThan(0);
  expect(subjectRoleKeys.length).toBeGreaterThan(0);

  const makeTerminal = (head: ZoneHead, source: ZoneGrantCleanupSource) =>
    terminalAdmission(
      source,
      f.accounts.owner,
      barriers[0]!,
      {
        accountId: head.ownerId!,
        revision: head.revision,
        lifecycleRevision: head.lifecycleRevision,
        transactionId: head.transactionId,
      },
    );
  await rollbackZonePage(zone.id, 1, makeTerminal);
  const initial = await withZonePage(zone.id, null, 1, makeTerminal);
  expect(initial.page).toMatchObject({ disposition: 'progress', candidateKeys: 2, processedKeys: 1 });
  const terminalBinding = initial.page.next!.scope.terminal;
  expect(terminalBinding).toMatchObject({
    accountId: f.accounts.owner,
    barrierVersion: barriers[0]!.version,
    barrierAt: barriers[0]!.at,
    primaryOwner: { accountId: f.accounts.owner },
  });
  await drain(zone.id, makeTerminal, initial.page.next);

  const remainingSubjectResource = await readOnly<{ erasure_key: string }>(
    'SELECT erasure_key::text FROM access.resource_grant WHERE erasure_key=ANY($1::bigint[])',
    [subjectResourceKeys.map((row) => row.erasure_key)],
  );
  const remainingSubjectRoles = await readOnly<{ erasure_key: string }>(
    'SELECT erasure_key::text FROM access.resource_role_grant WHERE erasure_key=ANY($1::bigint[])',
    [subjectRoleKeys.map((row) => row.erasure_key)],
  );
  expect(remainingSubjectResource).toEqual([]);
  expect(remainingSubjectRoles).toEqual([]);
  const survivingZoneRows = await readOnly<{ subject_id: string; action: string }>(
    `SELECT subject_id::text,action FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 ORDER BY subject_id,action`,
    [routeOf(zone.id), zone.id],
  );
  expect(survivingZoneRows).toContainEqual({ subject_id: f.accounts.editor, action: 'zone:configure' });
  expect(survivingZoneRows).toContainEqual({ subject_id: f.accounts.other, action: 'zone:read' });
  const unrelated = await readOnly<{ n: number }>(
    'SELECT count(*)::integer AS n FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
    [routeOf(otherZone.id), otherZone.id, f.accounts.owner],
  );
  expect(unrelated[0]!.n).toBe(1);

  await expect(
    addActionGrant(zone.id, f.accounts.owner, ['zone:read'], 'other'),
  ).rejects.toBeInstanceOf(GrantDeniedError);

  const survivingOwners = await readOnly<{ subject_id: string }>(
    `SELECT subject_id::text FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND grant_role='semantic.zone.owner'`,
    [routeOf(zone.id), zone.id],
  );
  expect(survivingOwners).toContainEqual({ subject_id: f.accounts.other });
});
