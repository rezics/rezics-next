import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { readAccount, readOrganizationRole, readPublicAccount } from '../../src/access/account-data.ts';
import { createDelegationCommands, readAssignment } from '../../src/access/delegation-commands.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createLifecycleCommands, createLifecycleInternals, REGISTRATION_TTL_MS } from '../../src/access/lifecycle.ts';
import {
  initializeResourceGrants,
  installStandingParentGrant,
  parentCreationAuthorization,
} from '../../src/access/index.ts';
import { runCommand } from '../../src/command/command.ts';
import {
  accessCommandAuthorization,
  type AccountActor,
  type ActionCatalogue,
  type Resource,
} from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type GrowthReport,
  type Population,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scalesPerUnit = 100;
const baselineOrdinals = 500;
const resourceSchema = 'growth_access_commands';
const resourceTable = `${resourceSchema}.resource`;
const actions: ActionCatalogue = new Map([
  ['account:read', { anonymous: false }],
  ['account:update', { anonymous: false }],
  ['account:delete', { anonymous: false, replay: 'self-account-read' }],
  ['organization:membership', { anonymous: false }],
  ['access:grant', { anonymous: false }],
  ['account:delegate', { anonymous: false }],
  ['subject:create', { anonymous: false }],
  ['subject:read', { anonymous: false }],
  ['subject:update', { anonymous: false }],
  ['board:read', { anonymous: false }],
  ['board:manage', { anonymous: false }],
  ['thread:create', { anonymous: false }],
  ['report:create', { anonymous: false }],
]);

let db: GrowthDatabase;
const accountEvidence = new Map<string, NonNullable<Awaited<ReturnType<typeof readAccount>>>>();
const access = createPermissionAccess({
  actions,
  accountEvidence: (actor) => accountEvidence.get(actor.accountId),
});

function accountRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new Error(`Invalid route ID: ${id}`);
  return route;
}

function lifecycle(clock?: () => Date) {
  return createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(73),
    ...(clock ? { clock } : {}),
    provisioningEvidence: async (value) => {
      if (!value || typeof value !== 'object') return null;
      return value as {
        accountId: string;
        registrationId: string;
        authIdentityId: string;
        authnEpoch: number;
      };
    },
    recoveryEvidence: async () => null,
  });
}

let internal: ReturnType<typeof lifecycle>;

async function createActor(partition: number, handle: string) {
  const route = partition * 16 + 3;
  const accountId = newId(route);
  const reserved = await internal.reserveHandle({ handle, accountId, key: Bun.randomUUIDv7() });
  await internal.createPending({
    accountId,
    handle,
    reservationId: reserved.value.reservationId,
    key: Bun.randomUUIDv7(),
  });
  await internal.activate({
    accountId,
    key: Bun.randomUUIDv7(),
    evidence: {
      accountId,
      authIdentityId: accountId,
      registrationId: reserved.value.reservationId,
      authnEpoch: 1,
    },
  });
  const account = await readAccount(db.pool, route, accountId);
  if (!account) throw new Error('Lifecycle fixture actor was not created');
  accountEvidence.set(accountId, account);
  return { accountId, account };
}

function actorFor(accountId: string, account: NonNullable<Awaited<ReturnType<typeof readAccount>>>): AccountActor {
  return {
    kind: 'account',
    accountId,
    clientId: 'growth-access-test',
    scopes: [...actions.keys()],
    requestedBy: null,
    authnEpoch: Number(account.minimumAuthnEpoch),
  };
}

function contextFor(accountId: string, account: NonNullable<Awaited<ReturnType<typeof readAccount>>>) {
  return {
    pool: db.pool,
    deadline: Date.now() + 30_000,
    account,
    actor: actorFor(accountId, account),
  };
}

async function grant(resource: Resource, subject: string, action: string, role = ''): Promise<void> {
  const transactionId = newId(resource.route);
  await db.admin.query(
    `INSERT INTO access.resource_grant
      (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
     VALUES ($1, $2, $3, $4, $5, '(,)'::tstzrange, $6)`,
    [resource.route, resource.id, subject, role, action, transactionId],
  );
}

async function organization(ownerId: string, partition: number) {
  const organizationId = newId(partition * 16 + 7);
  const hold = await internal.reserveCoordination({
    accountId: ownerId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: Bun.randomUUIDv7(),
  });
  await internal.createOrganization({
    organizationId,
    ownerAccountId: ownerId,
    ownerReservationId: hold.value.reservationId,
    key: Bun.randomUUIDv7(),
  });
  return organizationId;
}

async function check(
  population: Population,
  operation: GrowthCheck['operation'],
  name: string,
  ordinalsPerUnit = scalesPerUnit,
): Promise<GrowthReport> {
  await seed({ pool: db.pool, admin: db.admin }, population, {
    from: 100_000,
    to: 100_000 + baselineOrdinals,
  });
  return checkGrowth(db, {
    name,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 0,
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * ordinalsPerUnit,
        to: scale * ordinalsPerUnit,
      });
    },
    operation,
  });
}

type CommandHistoryEntry = { readonly kind: string; readonly eventType?: string };

function commandHistory(
  route: number,
  ordinal: number,
  entries: readonly CommandHistoryEntry[],
  recordReceipts = true,
): Record<string, readonly Record<string, unknown>[]> {
  const partition = partitionOf(route);
  const actorAccountId = newId(route);
  const response = { accountId: actorAccountId };
  const receipts: Record<string, unknown>[] = [];
  const outbox: Record<string, unknown>[] = [];
  const bases: Record<string, unknown>[] = [];
  for (const [index, entry] of entries.entries()) {
    const transactionId = newId(route);
    const position = 1_000_000 + ordinal * 64 + index;
    if (recordReceipts) {
      receipts.push({
        partition_no: partition,
        actor_account_id: actorAccountId,
        command_kind: `access.${entry.kind}`,
        idempotency_key: `${route}:growth:${ordinal}:${index}`,
        request_digest: new Uint8Array(32).fill(106),
        epoch: 1,
        position,
        transaction_id: transactionId,
        response,
      });
    }
    outbox.push({
      partition_no: partition,
      position,
      event_seq: 0,
      event_count: 1,
      epoch: 1,
      id: newId(route),
      type: entry.eventType ?? `com.rezics.access.${entry.kind}.v1`,
      subject: actorAccountId,
      data: response,
    });
    bases.push({
      partition_no: partition,
      transaction_id: transactionId,
      epoch: 1,
      position,
      actor_account_id: actorAccountId,
      client_id: 'growth-access-test',
      requested_by: null,
    });
  }
  return {
    ...(recordReceipts ? { 'core.receipt': receipts } : {}),
    'core.outbox': outbox,
    'editorial.write_basis': bases,
  };
}

function commandHistoryFinish(hotPartition: number): NonNullable<Population['finish']> {
  return async (admin) => {
    await admin.query(
      `UPDATE core.partition AS p
       SET position = GREATEST(
         p.position,
         COALESCE((SELECT max(r.position) FROM core.receipt AS r WHERE r.partition_no = p.partition_no), 0),
         COALESCE((SELECT max(o.position) FROM core.outbox AS o WHERE o.partition_no = p.partition_no), 0),
         COALESCE((SELECT max(w.position) FROM editorial.write_basis AS w WHERE w.partition_no = p.partition_no), 0)
       )
       WHERE p.partition_no = $1`,
      [hotPartition],
    );
  };
}

// These accounts, owner intervals and slots match lifecycle-create.sql and lifecycle membership inserts.
function accountAndMembershipPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const accountId = newId(route);
      const organizationId = newId(route);
      const accountTransactionId = newId(route);
      const organizationTransactionId = newId(route);
      const reservationId = newId(route);
      return {
        'access.account': [
          { route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: accountTransactionId },
          {
            route,
            account_id: organizationId,
            kind: 'organization',
            state: 'active',
            transaction_id: organizationTransactionId,
          },
        ],
        'access.organization_member': [
          {
            route,
            organization_id: organizationId,
            member_account_id: accountId,
            role: 'owner',
            valid: '(,)',
            transaction_id: organizationTransactionId,
          },
        ],
        'access.lifecycle_membership_slot': [
          {
            route,
            organization_id: organizationId,
            member_account_id: accountId,
            reservation_id: reservationId,
            terminal: false,
            transaction_id: organizationTransactionId,
          },
        ],
      };
    },
  };
}

// These grants and command history match grant-create.sql and the shared fence.sql envelope writes.
function grantPopulation(name: string, hotPartition: number, commandKinds: readonly CommandHistoryEntry[]): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const resourceId = newId(route);
      const subjectId = newId(route);
      const transactionId = newId(route);
      return {
        'access.resource_grant': [
          {
            route,
            resource_id: resourceId,
            subject_kind: 'identity',
            subject_id: subjectId,
            subject_role: '',
            action: 'subject:read',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        ...commandHistory(route, ordinal, commandKinds),
      };
    },
  };
}

// These account, self-grant and command-history rows match lifecycle-create.sql, lifecycle-default-grants.sql and fence.sql.
function accountDefaultGrantPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const accountId = newId(route);
      const transactionId = newId(route);
      return {
        'access.account': [
          { route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: transactionId },
        ],
        'access.resource_grant': ['account:update', 'account:delete'].map((action) => ({
          route,
          resource_id: accountId,
          subject_kind: 'identity',
          subject_id: accountId,
          subject_role: '',
          action,
          valid: '(,)',
          transaction_id: transactionId,
        })),
        ...commandHistory(route, ordinal, [{ kind: 'actor-pending' }, { kind: 'organization-created' }]),
      };
    },
  };
}

// These principal and command-history rows match delegation-create.sql, its identity trigger and fence.sql.
function assignmentPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const principalId = newId(route);
      const requestId = newId(route);
      const transactionId = newId(route);
      return {
        'access.account': [
          { route, account_id: principalId, kind: 'actor', state: 'active', transaction_id: newId(route) },
        ],
        'access.principal_assignment': [
          {
            route,
            principal_id: principalId,
            creator_principal_id: principalId,
            request_id: requestId,
            assigned_actor_id: newId(route),
            valid: '(,)',
            issued_valid: '(,)',
            revoked_at: null,
            transaction_id: transactionId,
          },
        ],
        ...commandHistory(route, ordinal, [{ kind: 'assignment.create' }, { kind: 'assignment.revoke' }]),
      };
    },
  };
}

// These resource-role and command-history rows match resource-initialization.sql and fence.sql without receipts.
function resourceRolePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const resourceId = newId(route);
      const identityId = newId(route);
      const transactionId = newId(route);
      const initializedAt = '2026-01-01T00:00:00.000Z';
      return {
        'access.resource_initialization': [
          {
            route,
            resource_id: resourceId,
            resource_type: 'content.board',
            creator_id: identityId,
            initialized_at: initializedAt,
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: resourceId,
            subject_kind: 'identity',
            subject_id: identityId,
            subject_role: '',
            grant_role: 'content.board.owner',
            valid: '[2026-01-01T00:00:00.000Z,)',
            transaction_id: transactionId,
          },
          {
            route,
            resource_id: resourceId,
            subject_kind: 'active_accounts',
            subject_id: '00000000-0000-0000-0000-000000000000',
            subject_role: '',
            grant_role: 'content.board.standing',
            valid: '[2026-01-01T00:00:00.000Z,)',
            transaction_id: transactionId,
          },
        ],
        ...commandHistory(
          route,
          ordinal,
          [{ kind: 'resource-created', eventType: 'com.rezics.fixture.resource-created.v1' }],
          false,
        ),
      };
    },
  };
}

// These hold, fence and command-history rows match lifecycle-coordination.sql, lifecycle-fence.sql and fence.sql.
function coordinationAndFencePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const accountId = newId(route);
      const reservationId = newId(route);
      const receiptId = newId(route);
      const accountTransactionId = newId(route);
      const holdTransactionId = newId(route);
      const fenceTransactionId = newId(route);
      return {
        'access.account': [
          { route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: accountTransactionId },
        ],
        'access.lifecycle_coordination': [
          {
            route,
            account_id: accountId,
            reservation_id: reservationId,
            related_account_id: newId(route),
            purpose: 'membership',
            transaction_id: holdTransactionId,
          },
        ],
        'access.lifecycle_fence_receipt': [
          {
            route,
            account_id: accountId,
            receipt_id: receiptId,
            minimum_authn_epoch: 2,
            kind: 'fence',
            prior_operator_account_id: null,
            transaction_id: fenceTransactionId,
          },
        ],
        ...commandHistory(route, ordinal, [
          { kind: 'account-updated' },
          { kind: 'coordination-reserved' },
          { kind: 'authentication-fenced' },
        ]),
      };
    },
  };
}

// These unrelated intervals, slots and command history match lifecycle membership writes and fence.sql.
function membershipPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const organizationId = newId(route);
      const memberId = newId(route);
      const reservationId = newId(route);
      const transactionId = newId(route);
      return {
        'access.organization_member': [
          {
            route,
            organization_id: organizationId,
            member_account_id: memberId,
            role: 'member',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.lifecycle_membership_slot': [
          {
            route,
            organization_id: organizationId,
            member_account_id: memberId,
            reservation_id: reservationId,
            terminal: false,
            transaction_id: transactionId,
          },
        ],
        ...commandHistory(route, ordinal, [{ kind: 'membership-changed' }]),
      };
    },
  };
}

function hashRoute(value: string): number {
  return createHash('sha256').update(value).digest().readUInt16BE(0);
}

function handleInPartition(partition: number, ordinal: number): string {
  for (let attempt = 0; ; attempt++) {
    const handle = `g${ordinal.toString(16).padStart(8, '0')}x${attempt.toString(16).padStart(8, '0')}`;
    if (hashRoute(handle) >>> 4 === partition) return handle;
  }
}

// These hashed claims and command history match lifecycle-handle-reserve.sql and fence.sql.
function handlePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ ordinal, route: populationRoute }) => {
      const handle = handleInPartition(hotPartition, ordinal);
      const route = hashRoute(handle);
      const accountId = newId(route);
      const transactionId = newId(route);
      return {
        'access.handle_claim': [
          {
            route,
            normalized_handle: handle,
            account_id: accountId,
            state: 'pending',
            expires_at: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
            reserved_until: null,
            transaction_id: transactionId,
            reservation_id: newId(route),
          },
        ],
        ...commandHistory(populationRoute, ordinal, [
          { kind: 'handle-reserved' },
          { kind: 'handle-reserved' },
          { kind: 'handle-expired' },
          { kind: 'handle-expired' },
        ]),
      };
    },
  };
}

// These organization, owner, grant, interval, slot and command rows match lifecycle creation and fence.sql.
function tombstonePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(hotPartition),
    rows: ({ route, ordinal }) => {
      const accountId = newId(route);
      const ownerId = newId(route);
      const transactionId = newId(route);
      const reservationId = newId(route);
      return {
        'access.account': [
          { route, account_id: ownerId, kind: 'actor', state: 'active', transaction_id: newId(route) },
          { route, account_id: accountId, kind: 'organization', state: 'active', transaction_id: transactionId },
        ],
        'access.resource_grant': [
          ...['account:update', 'account:delete'].map((action) => ({
            route,
            resource_id: ownerId,
            subject_kind: 'identity',
            subject_id: ownerId,
            subject_role: '',
            action,
            valid: '(,)',
            transaction_id: newId(route),
          })),
          ...['account:update', 'account:delete', 'organization:membership'].map((action) => ({
            route,
            resource_id: accountId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: 'owner',
            action,
            valid: '(,)',
            transaction_id: transactionId,
          })),
        ],
        'access.organization_member': [
          {
            route,
            organization_id: accountId,
            member_account_id: ownerId,
            role: 'owner',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.lifecycle_membership_slot': [
          {
            route,
            organization_id: accountId,
            member_account_id: ownerId,
            reservation_id: reservationId,
            terminal: false,
            transaction_id: transactionId,
          },
        ],
        ...commandHistory(route, ordinal, [{ kind: 'account-tombstoned' }]),
      };
    },
  };
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  internal = lifecycle();
  await db.admin.query(`CREATE SCHEMA ${resourceSchema}`);
  await db.admin.query(`CREATE TABLE ${resourceTable} (
    route integer NOT NULL,
    id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    PRIMARY KEY (route, id)
  )`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${resourceSchema} CASCADE`);
  await db.close();
});

test.serial(
  'Account read and public projection stays within its bound as A grows',
  async () => {
    const partition = 1537;
    const owner = await createActor(partition, 'growth_account_owner');
    const organizationId = await organization(owner.accountId, partition);
    const at = new Date().toISOString();
    const resource: Resource = { route: accountRoute(organizationId), id: organizationId };
    const population = accountAndMembershipPopulation('growth-access-account-read', partition);
    const report = await check(
      population,
      async () => {
        await readAccount(db.pool, resource.route, organizationId);
        await readPublicAccount(db.pool, resource.route, organizationId);
        await readOrganizationRole(db.pool, resource.route, organizationId, owner.accountId, new Date(at));
      },
      'Account read and public projection stays within its bound as A grows',
    );
    expect(report).toMatchObject({ bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } });
  },
  90_000,
);

test.serial(
  'Standing parent installation stays within its bound as Gt grows',
  async () => {
    const partition = 1538;
    const parents: Awaited<ReturnType<typeof createActor>>[] = [];
    for (let index = 0; index < 3; index++) parents.push(await createActor(partition, `growth_standing_${index}`));
    const parentResources = parents.map(({ accountId }) => ({ route: accountRoute(accountId), id: accountId }));
    for (const parent of parentResources) {
      const actorId = parents.find(({ accountId }) => accountId === parent.id)!.accountId;
      await grant(parent, actorId, 'subject:create');
      await grant(parent, actorId, 'access:grant');
    }
    const population = grantPopulation('growth-access-standing-parent', partition, [
      { kind: 'standing-parent.install', eventType: 'com.rezics.access.standing-parent.installed.v1' },
    ]);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const resource = parentResources[repetition]!;
        const parentAccount = parents[repetition]!;
        const context = contextFor(parentAccount.accountId, parentAccount.account);
        const parent = {
          resource,
          validate: async (client: Parameters<typeof readAccount>[0]) =>
            Boolean(await readAccount(client, resource.route, resource.id)),
        };
        const authority = await accessCommandAuthorization(
          access,
          context.actor,
          'access:grant',
          resource,
          context,
          () => new GrantDeniedError(),
        );
        return installStandingParentGrant({ access, authority, parent, context, actions: ['subject:create'] });
      },
      'Standing parent installation stays within its bound as Gt grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Creator grant initialization stays within its bound as Gt grows',
  async () => {
    const partition = 1539;
    const creator = await createActor(partition, 'growth_initializer_creator');
    const parent: Resource = { route: accountRoute(creator.accountId), id: creator.accountId };
    await grant(parent, creator.accountId, 'subject:create');
    const context = contextFor(creator.accountId, creator.account);
    const children = Array.from({ length: 3 }, () => ({ route: parent.route, id: newId(parent.route) }));
    const population = resourceRolePopulation('growth-access-resource-initialization', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const resource = children[repetition]!;
        const authorization = parentCreationAuthorization({
          access,
          actor: context.actor,
          action: 'subject:create',
          parent: {
            resource: parent,
            validate: async (client) => Boolean(await readAccount(client, parent.route, parent.id)),
          },
          context: {
            pool: db.pool,
            deadline: Date.now() + 30_000,
            resource,
            creation: {
              validate: async (tx, child) => {
                const found = await tx.query(`SELECT 1 FROM ${resourceTable} WHERE route=$1 AND id=$2`, [
                  child.route,
                  child.id,
                ]);
                return found.rowCount === 1;
              },
            },
          },
        });
        return runCommand(
          db.pool,
          {
            partition: partitionOf(resource.route),
            deadline: Date.now() + 30_000,
            basis: { actorAccountId: context.actor.accountId, clientId: context.actor.clientId, requestedBy: null },
            authorization,
          },
          async (tx, { transactionId }) => {
            await tx.query(`INSERT INTO ${resourceTable} (route, id, transaction_id) VALUES ($1,$2,$3)`, [
              resource.route,
              resource.id,
              transactionId,
            ]);
            await initializeResourceGrants(tx, { resource, type: 'content.board', creator: creator.accountId });
            return { value: resource, events: [{ type: 'com.rezics.fixture.resource-created.v1', data: resource }] };
          },
        );
      },
      'Creator grant initialization stays within its bound as Gt grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Grant create/change/revoke stays within its bound as Gt grows',
  async () => {
    const partition = 1540;
    const actor = await createActor(partition, 'growth_grant_actor');
    const resource: Resource = { route: partition * 16 + 5, id: newId(partition * 16 + 5) };
    for (const action of ['access:grant', 'subject:read', 'subject:update'])
      await grant(resource, actor.accountId, action);
    const commands = createGrantCommands({ pool: db.pool, access, managementAction: 'access:grant' });
    const context = contextFor(actor.accountId, actor.account);
    const recipientId = newId(resource.route);
    const population = grantPopulation('growth-access-grant-commands', partition, [
      { kind: 'grant.create' },
      { kind: 'grant.change' },
      { kind: 'grant.revoke' },
    ]);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const ctx = contextFor(actor.accountId, actor.account);
        const base = {
          resource,
          subjectId: recipientId,
          subjectRole: '' as const,
          valid: '[2000-01-01,2001-01-01)',
        };
        await commands.create(ctx, { ...base, actions: ['subject:read'], key: `growth-create-${repetition}` });
        await commands.change(ctx, {
          ...base,
          actions: ['subject:update'],
          key: `growth-change-${repetition}`,
          previous: { actions: ['subject:read'], valid: base.valid },
        });
        const result = await commands.revoke(ctx, {
          ...base,
          actions: ['subject:update'],
          key: `growth-revoke-${repetition}`,
        });
        return result;
      },
      'Grant create/change/revoke stays within its bound as Gt grows',
    );
    expect(context.account.accountId).toBe(actor.accountId);
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Delegation create/revoke/read stays within its bound as A grows',
  async () => {
    const partition = 1541;
    const principal = await createActor(partition, 'growth_delegation_principal');
    const resource: Resource = { route: accountRoute(principal.accountId), id: principal.accountId };
    await grant(resource, principal.accountId, 'account:delegate');
    const commands = createDelegationCommands({ pool: db.pool, access, action: 'account:delegate' });
    const population = assignmentPopulation('growth-access-delegation', partition);
    const requestId = newId(resource.route);
    const assignedActorId = newId(resource.route);
    const requestedBy = `urn:rezics:request:${principal.accountId}:${requestId}`;
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const ctx = contextFor(principal.accountId, principal.account);
        const input = {
          principalId: principal.accountId,
          assignedActorId,
          requestId,
          valid: '(,)',
          key: `growth-delegation-create-${repetition}`,
        };
        await commands.create(ctx, input);
        const read = await readAssignment(db.pool, requestedBy, assignedActorId);
        await commands.revoke(ctx, {
          principalId: principal.accountId,
          requestId,
          key: `growth-delegation-revoke-${repetition}`,
        });
        await db.admin.query(
          'DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3',
          [resource.route, principal.accountId, requestId],
        );
        return read;
      },
      'Delegation create/revoke/read stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Account and organization creation stays within its bound as A grows',
  async () => {
    const partition = 1542;
    const owner = await createActor(partition, 'growth_creation_owner');
    const targets: {
      actorId: string;
      handle: string;
      reservationId: string;
      organizationId: string;
      ownerHold: string;
    }[] = [];
    for (let index = 0; index < 3; index++) {
      const actorId = newId(partition * 16 + 5);
      const handle = `growthnew${index}`;
      const reservation = await internal.reserveHandle({ handle, accountId: actorId, key: Bun.randomUUIDv7() });
      const organizationId = newId(partition * 16 + 8);
      const hold = await internal.reserveCoordination({
        accountId: owner.accountId,
        relatedAccountId: organizationId,
        purpose: 'membership',
        key: Bun.randomUUIDv7(),
      });
      targets.push({
        actorId,
        handle,
        reservationId: reservation.value.reservationId,
        organizationId,
        ownerHold: hold.value.reservationId,
      });
    }
    const population = accountDefaultGrantPopulation('growth-access-creations', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const target = targets[repetition]!;
        await internal.createPending({
          accountId: target.actorId,
          handle: target.handle,
          reservationId: target.reservationId,
          key: `growth-pending-${repetition}`,
        });
        return internal.createOrganization({
          organizationId: target.organizationId,
          ownerAccountId: owner.accountId,
          ownerReservationId: target.ownerHold,
          key: `growth-organization-${repetition}`,
        });
      },
      'Account and organization creation stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Handle reserve/change/resolve/expire stays within its bound as A grows',
  async () => {
    const handle = 'growth_handle_anchor';
    const partition = hashRoute(handle) >>> 4;
    const firstAccount = await createActor(partition, 'growth_handle_first');
    const secondAccount = await createActor(partition, 'growth_handle_second');
    let instant = new Date('2026-01-01T00:00:00.000Z');
    const timed = lifecycle(() => new Date(instant));
    const population = handlePopulation('growth-access-handle-claims', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        instant = new Date('2026-01-01T00:00:00.000Z');
        await timed.reserveHandle({
          handle,
          accountId: firstAccount.accountId,
          key: `growth-handle-first-${repetition}`,
        });
        const beforeChange = await timed.resolveHandle(handle);
        instant = new Date(instant.getTime() + REGISTRATION_TTL_MS + 1);
        await timed.reserveHandle({
          handle,
          accountId: secondAccount.accountId,
          key: `growth-handle-change-${repetition}`,
        });
        const afterChange = await timed.resolveHandle(handle);
        instant = new Date(instant.getTime() + REGISTRATION_TTL_MS + 1);
        await timed.expireHandle({ handle, key: `growth-handle-expire-${repetition}` });
        return { beforeChange, afterChange, expired: await timed.resolveHandle(handle) };
      },
      'Handle reserve/change/resolve/expire stays within its bound as A grows',
      8,
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Account update, coordination and fences stays within its bound as A grows',
  async () => {
    const partition = 1544;
    const actor = await createActor(partition, 'growth_update_actor');
    const target = await createActor(partition, 'growth_update_target');
    const fenceTarget = await createActor(partition, 'growth_fence_target');
    const resource: Resource = { route: accountRoute(target.accountId), id: target.accountId };
    await grant(resource, actor.accountId, 'account:update');
    const commands = createLifecycleCommands({ pool: db.pool, access });
    const population = coordinationAndFencePopulation('growth-access-account-commands', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const ctx = contextFor(actor.accountId, actor.account);
        const update = await commands.updateAccount(ctx, {
          accountId: target.accountId,
          key: `growth-account-update-${repetition}`,
          patch: { displayName: `growth-${repetition}` },
        });
        const hold = await internal.reserveCoordination({
          accountId: actor.accountId,
          relatedAccountId: target.accountId,
          purpose: 'membership',
          key: `growth-coordination-${repetition}`,
        });
        const fence = await internal.raiseFence({
          accountId: fenceTarget.accountId,
          key: `growth-fence-${repetition}`,
        });
        const receipt = await internal.readFenceReceipt(fenceTarget.accountId, fence.value.receiptId);
        const state = await internal.readFenceState(fenceTarget.accountId);
        return { update, hold, fence, receipt, state };
      },
      'Account update, coordination and fences stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Membership change stays within its bound as m grows',
  async () => {
    const partition = 1545;
    const owner = await createActor(partition, 'growth_membership_owner');
    const member = await createActor(partition, 'growth_membership_member');
    const organizationId = await organization(owner.accountId, partition);
    const hold = await internal.reserveCoordination({
      accountId: member.accountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: 'growth-membership-hold',
    });
    const commands = createLifecycleCommands({ pool: db.pool, access });
    const population = membershipPopulation('growth-access-membership-change', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) =>
        commands.setMembership(contextFor(owner.accountId, owner.account), {
          organizationId,
          memberAccountId: member.accountId,
          reservationId: hold.value.reservationId,
          role: 'member',
          key: `growth-membership-change-${repetition}`,
        }),
      'Membership change stays within its bound as m grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);

test.serial(
  'Tombstone erasure stays within its bound as m grows',
  async () => {
    const partition = 1546;
    const actor = await createActor(partition, 'growth_tombstone_actor');
    const targets: string[] = [];
    for (let index = 0; index < 3; index++) {
      const id = newId(partition * 16 + 9);
      const hold = await internal.reserveCoordination({
        accountId: actor.accountId,
        relatedAccountId: id,
        purpose: 'membership',
        key: `growth-tombstone-hold-${index}`,
      });
      await internal.createOrganization({
        organizationId: id,
        ownerAccountId: actor.accountId,
        ownerReservationId: hold.value.reservationId,
        key: `growth-tombstone-org-${index}`,
      });
      await db.admin.query('DELETE FROM access.organization_member WHERE route=$1 AND organization_id=$2', [
        accountRoute(id),
        id,
      ]);
      await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
        accountRoute(id),
        id,
      ]);
      await grant({ route: accountRoute(id), id }, actor.accountId, 'account:delete');
      targets.push(id);
    }
    const commands = createLifecycleCommands({ pool: db.pool, access });
    const population = tombstonePopulation('growth-access-tombstones', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) =>
        commands.tombstone(contextFor(actor.accountId, actor.account), {
          accountId: targets[repetition]!,
          key: `growth-tombstone-${repetition}`,
        }),
      'Tombstone erasure stays within its bound as m grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  90_000,
);
