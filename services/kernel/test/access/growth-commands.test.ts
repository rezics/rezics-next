import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { readAccount, readOrganizationRole, readPublicAccount } from '../../src/access/account-data.ts';
import { createDelegationCommands, readAssignment } from '../../src/access/delegation-commands.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  HANDLE_REDIRECT_TTL_MS,
  REGISTRATION_TTL_MS,
} from '../../src/access/lifecycle.ts';
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

const ordinalsPerScale = 500;
const baselineOrdinals = 2_000;
const operationsPerCheck = 18;
const resourceSchema = 'growth_access_commands';
const resourceTable = `${resourceSchema}.resource`;
const actions: ActionCatalogue = new Map([
  ['account:read', { anonymous: false }],
  ['account:update', { anonymous: false }],
  ['account:delete', { anonymous: false, replay: 'self-account-read' }],
  ['organization:membership', { anonymous: false }],
  ['access:grant', { anonymous: false }],
  ['account:delegate', { anonymous: false }],
  ['subject:create', { anonymous: false, 'x-resource-types': ['content.board'] }],
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

async function check(population: Population, operation: GrowthCheck['operation'], name: string): Promise<GrowthReport> {
  const queryTexts = new Set<string>();
  const statementRuns = new Map<number, string[]>();
  const callsPerScale = new Map<number, number>();
  const observedClients = new Map<
    PoolClient,
    { notice: (notice: { message: string | undefined }) => void; query: PoolClient['query'] }
  >();
  let activeStatementRun: string[] | undefined;
  const observeClient = (client: PoolClient) => {
    if (observedClients.has(client)) return;
    const observeNotice = (notice: { message: string | undefined }) => {
      const message = notice.message;
      const marker = 'plan:\n';
      if (typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker)) return;
      try {
        collectCatalogQueryTexts(JSON.parse(message.slice(message.indexOf(marker) + marker.length)), queryTexts);
      } catch {
        // The harness already reports malformed auto_explain notices for measured operations.
      }
    };
    const originalQuery = client.query;
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const statement = statementText(args[0]);
      if (activeStatementRun && statement !== undefined) activeStatementRun.push(statement);
      return originalQuery.apply(client, args);
    }) as PoolClient['query'];
    observedClients.set(client, { notice: observeNotice, query: originalQuery });
    client.on('notice', observeNotice);
  };
  db.pool.on('acquire', observeClient);

  try {
    await seed({ pool: db.pool, admin: db.admin }, population, {
      from: 100_000,
      to: 100_000 + baselineOrdinals,
    });
    const report = await checkGrowth(db, {
      name,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (growthDb, scale, previous) => {
        await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
          from: previous * ordinalsPerScale,
          to: scale * ordinalsPerScale,
        });
      },
      operation: async (growthDb, scale, repetition) => {
        const calls = callsPerScale.get(scale) ?? 0;
        callsPerScale.set(scale, calls + 1);
        // Capture the first measured run after its warm-up at the smallest and largest scales.
        const captureRun = (scale === 1 || scale === 64) && calls === 1;
        const statements = captureRun ? [] : undefined;
        if (statements) statementRuns.set(scale, statements);
        activeStatementRun = statements;
        try {
          return await operation(growthDb, scale, repetition);
        } finally {
          activeStatementRun = undefined;
        }
      },
    });
    printCatalogQueryTexts(report.samples, queryTexts);
    return report;
  } catch (error) {
    if (isGrowthFailure(error)) {
      printStatementRuns(name, statementRuns);
      printCatalogQueryTexts(error.samples, queryTexts);
    }
    throw error;
  } finally {
    db.pool.off('acquire', observeClient);
    for (const [client, observed] of observedClients) {
      client.off('notice', observed.notice);
      client.query = observed.query;
    }
    await clearFixtureRows();
  }
}

function statementText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return undefined;
  return typeof query.text === 'string' ? query.text : undefined;
}

function printStatementRuns(name: string, runs: ReadonlyMap<number, readonly string[]>): void {
  for (const scale of [1, 64]) {
    const statements = runs.get(scale);
    if (!statements) continue;
    const firstLines = statements.map(
      (statement) =>
        statement
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() ?? '',
    );
    console.info(`${name} scale ${scale} statement texts (first line per statement):\n${firstLines.join('\n')}`);
  }
}

function isGrowthFailure(error: unknown): error is Error & { samples: readonly GrowthReport['samples'][number][] } {
  return error instanceof Error && error.name === 'GrowthBoundError' && 'samples' in error;
}

function hasCatalogRelation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCatalogRelation);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const relation = record['Relation Name'];
  const schema = record.Schema;
  if (
    typeof relation === 'string' &&
    (schema === 'pg_catalog' || (schema === undefined && ['pg_attribute', 'pg_type'].includes(relation)))
  ) {
    return true;
  }
  return Object.values(record).some(hasCatalogRelation);
}

function collectCatalogQueryTexts(value: unknown, queryTexts: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectCatalogQueryTexts(entry, queryTexts);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record['Query Text'] === 'string' && hasCatalogRelation(record.Plan)) {
    queryTexts.add(record['Query Text']);
  }
  for (const child of Object.values(record)) collectCatalogQueryTexts(child, queryTexts);
}

function printCatalogQueryTexts(samples: GrowthReport['samples'], queryTexts: Set<string>): void {
  const catalogRelations = new Set(
    samples.flatMap(({ cost }) =>
      Object.keys(cost.relations ?? {}).filter(
        (relation) => relation.startsWith('pg_catalog.') || ['pg_attribute', 'pg_type'].includes(relation),
      ),
    ),
  );
  if (catalogRelations.size === 0) return;
  console.info(`Growth check ${[...catalogRelations].join(', ')} Query Text:\n${[...queryTexts].join('\n')}`);
}

async function clearFixtureRows(): Promise<void> {
  await db.admin.query(`
    TRUNCATE TABLE
      core.receipt,
      core.outbox,
      editorial.write_basis,
      access.account,
      access.handle_claim,
      access.lifecycle_coordination,
      access.lifecycle_fence_receipt,
      access.lifecycle_membership_slot,
      access.membership_inverse,
      access.organization_member,
      access.principal_assignment,
      access.resource_denial,
      access.resource_grant,
      access.resource_initialization,
      access.resource_role_grant,
      access.standing_parent_installation,
      ${resourceTable}
    CASCADE
  `);
  await db.admin.query('UPDATE core.partition SET position = 0');
  await db.admin.query('CHECKPOINT');
  accountEvidence.clear();
}

type CommandHistoryEntry = { readonly kind: string; readonly eventType?: string };

// Receipt and outbox JSON mirror each command's returned value because the executor stores that value verbatim.
function commandHistoryValue(
  route: number,
  ordinal: number,
  index: number,
  entry: CommandHistoryEntry,
  actorAccountId: string,
): { value: Record<string, unknown>; subject: string } {
  const resource = { route, id: newId(route) };
  const relatedAccountId = newId(route);
  const reservationId = newId(route);
  const handle = `growth-history-${ordinal}-${index}`;
  switch (entry.kind) {
    case 'standing-parent.install':
      return { value: { resource, actions: ['subject:create'] }, subject: resource.id };
    case 'grant.create':
    case 'grant.change':
    case 'grant.revoke':
      return {
        value: { resource, subjectId: relatedAccountId, subjectRole: '', actions: ['subject:read'], valid: '(,)' },
        subject: resource.id,
      };
    case 'assignment.create':
    case 'assignment.revoke':
      return {
        value: { requestedBy: `urn:rezics:request:${actorAccountId}:${reservationId}` },
        subject: actorAccountId,
      };
    case 'actor-pending':
      return {
        value: {
          accountId: actorAccountId,
          registrationId: reservationId,
          expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
        },
        subject: actorAccountId,
      };
    case 'organization-created':
      return { value: { accountId: resource.id, ownerAccountId: actorAccountId }, subject: resource.id };
    case 'handle-reserved':
      return {
        value: {
          handle,
          accountId: relatedAccountId,
          reservationId,
          expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
        },
        subject: handle,
      };
    case 'handle-claimed':
      return { value: { handle, accountId: relatedAccountId }, subject: handle };
    case 'handle-redirected':
      return {
        value: {
          handle,
          accountId: relatedAccountId,
          reservedUntil: new Date(Date.now() + HANDLE_REDIRECT_TTL_MS).toISOString(),
        },
        subject: handle,
      };
    case 'handle-expired':
      return { value: { handle }, subject: handle };
    case 'resource-created':
      return { value: resource, subject: resource.id };
    case 'account-updated':
      return { value: { accountId: actorAccountId }, subject: actorAccountId };
    case 'coordination-reserved':
      return {
        value: { accountId: actorAccountId, relatedAccountId, purpose: 'membership', reservationId },
        subject: actorAccountId,
      };
    case 'authentication-fenced':
      return {
        value: {
          receiptId: reservationId,
          accountId: actorAccountId,
          minimumAuthnEpoch: '2',
          kind: 'fence',
          priorOperatorAccountId: null,
        },
        subject: actorAccountId,
      };
    case 'membership-changed':
      return {
        value: { organizationId: resource.id, memberAccountId: relatedAccountId, reservationId, role: 'member' },
        subject: resource.id,
      };
    case 'account-tombstoned':
      return {
        value: {
          receiptId: reservationId,
          accountId: actorAccountId,
          minimumAuthnEpoch: '2',
          kind: 'tombstone',
          priorOperatorAccountId: null,
        },
        subject: actorAccountId,
      };
    default:
      return { value: { accountId: actorAccountId }, subject: actorAccountId };
  }
}

function commandHistory(
  route: number,
  ordinal: number,
  entries: readonly CommandHistoryEntry[],
): Record<string, readonly Record<string, unknown>[]> {
  const partition = partitionOf(route);
  const actorAccountId = newId(route);
  const receipts: Record<string, unknown>[] = [];
  const outbox: Record<string, unknown>[] = [];
  const bases: Record<string, unknown>[] = [];
  for (const [index, entry] of entries.entries()) {
    const transactionId = newId(route);
    const position = 1_000_000 + ordinal * 64 + index;
    const { value, subject } = commandHistoryValue(route, ordinal, index, entry, actorAccountId);
    receipts.push({
      partition_no: partition,
      principal_kind: 'account',
      principal_id: actorAccountId,
      command_kind: `access.${entry.kind}`,
      idempotency_key: `${route}:growth:${ordinal}:${index}`,
      request_digest: new Uint8Array(32).fill(106),
      epoch: 1,
      position,
      transaction_id: transactionId,
      response: value,
    });
    outbox.push({
      partition_no: partition,
      position,
      event_seq: 0,
      event_count: 1,
      epoch: 1,
      id: newId(route),
      type: entry.eventType ?? `com.rezics.access.${entry.kind}.v1`,
      subject,
      data: value,
    });
    bases.push({
      partition_no: partition,
      transaction_id: transactionId,
      epoch: 1,
      position,
      principal_kind: 'account',
      principal_id: actorAccountId,
      client_id: 'growth-access-test',
      requested_by: null,
    });
  }
  return {
    'core.receipt': receipts,
    'core.outbox': outbox,
    'editorial.write_basis': bases,
  };
}

function commandHistoryFinish(): NonNullable<Population['finish']> {
  return async (admin) => {
    await admin.query(
      `WITH positions AS (
         SELECT partition_no, max(position) AS position
         FROM (
           SELECT partition_no, position FROM core.receipt
           UNION ALL
           SELECT partition_no, position FROM core.outbox
           UNION ALL
           SELECT partition_no, position FROM editorial.write_basis
         ) AS history
         GROUP BY partition_no
       )
       UPDATE core.partition AS p
       SET position = GREATEST(p.position, positions.position)
       FROM positions
       WHERE p.partition_no = positions.partition_no`,
    );
  };
}

type PermissionRows = {
  'access.resource_grant': Record<string, unknown>[];
  'access.resource_role_grant': Record<string, unknown>[];
  'access.resource_denial': Record<string, unknown>[];
};

function permissionRows(route: number): PermissionRows {
  const grantTransactionId = newId(route);
  const roleTransactionId = newId(route);
  const denialTransactionId = newId(route);
  return {
    'access.resource_grant': [
      {
        route,
        resource_id: newId(route),
        subject_kind: 'identity',
        subject_id: newId(route),
        subject_role: '',
        action: 'subject:read',
        valid: '(,)',
        transaction_id: grantTransactionId,
      },
    ],
    'access.resource_role_grant': [
      {
        route,
        resource_id: newId(route),
        subject_kind: 'identity',
        subject_id: newId(route),
        subject_role: '',
        grant_role: 'content.board.owner',
        valid: '[2026-01-01T00:00:00.000Z,)',
        transaction_id: roleTransactionId,
      },
    ],
    'access.resource_denial': [
      {
        route,
        resource_id: newId(route),
        subject_id: newId(route),
        subject_role: '',
        action: 'subject:read',
        reason: 'resource',
        valid: '(,)',
        transaction_id: denialTransactionId,
      },
    ],
  };
}

function accountRow(route: number, kind: 'actor' | 'organization' = 'actor'): Record<string, unknown> {
  return { route, account_id: newId(route), kind, state: 'active', transaction_id: newId(route) };
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

// These accounts, grant variants and command history match lifecycle creation, permission writes and fence.sql.
function grantPopulation(
  name: string,
  hotPartition: number,
  commandKinds: readonly CommandHistoryEntry[],
  includeStandingMarkers = false,
): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal }) => {
      const authorizationRows = permissionRows(route);
      const resourceId = newId(route);
      const subjectId = newId(route);
      const transactionId = newId(route);
      const population = {
        ...authorizationRows,
        'access.account': [accountRow(route)],
        'access.resource_grant': [
          ...authorizationRows['access.resource_grant'],
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
        ...(includeStandingMarkers
          ? {
              'access.standing_parent_installation': [
                {
                  route,
                  resource_id: newId(route),
                  actions: ['subject:create'],
                  transaction_id: newId(route),
                },
              ],
            }
          : {}),
        ...commandHistory(route, ordinal, commandKinds),
      };
      return population;
    },
  };
}

// These handles, holds, accounts, grants, memberships and command history match lifecycle creation and its writes.
function accountDefaultGrantPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 0.25,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal, hot }) => {
      const accountId = newId(route);
      const organizationId = newId(route);
      const reservationId = newId(route);
      const handle = hot ? handleInPartition(hotPartition, 200_000 + ordinal) : `growth-account-handle-${ordinal}`;
      const handleRouteValue = hashRoute(handle);
      const accountTransactionId = newId(route);
      const organizationTransactionId = newId(route);
      const permissionRowsForRoute = permissionRows(route);
      return {
        ...permissionRowsForRoute,
        'access.account': [
          {
            route,
            account_id: accountId,
            kind: 'actor',
            handle,
            state: 'active',
            transaction_id: accountTransactionId,
          },
          {
            route,
            account_id: organizationId,
            kind: 'organization',
            handle: null,
            state: 'active',
            transaction_id: organizationTransactionId,
          },
        ],
        'access.handle_claim': [
          {
            route: handleRouteValue,
            normalized_handle: handle,
            account_id: accountId,
            state: 'pending',
            expires_at: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
            reserved_until: null,
            transaction_id: newId(handleRouteValue),
            reservation_id: newId(handleRouteValue),
          },
        ],
        'access.lifecycle_coordination': [
          {
            route,
            account_id: accountId,
            reservation_id: newId(route),
            related_account_id: organizationId,
            purpose: 'membership',
            transaction_id: newId(route),
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
        'access.resource_grant': [
          ...permissionRowsForRoute['access.resource_grant'],
          ...['account:update', 'account:delete', 'account:read'].map((action) => ({
            route,
            resource_id: accountId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: '',
            action,
            valid: '(,)',
            transaction_id: accountTransactionId,
          })),
          ...['account:update', 'account:delete', 'organization:membership'].map((action) => ({
            route,
            resource_id: organizationId,
            subject_kind: 'identity',
            subject_id: organizationId,
            subject_role: 'owner',
            action,
            valid: '(,)',
            transaction_id: organizationTransactionId,
          })),
        ],
        ...commandHistory(route, ordinal, [{ kind: 'actor-pending' }, { kind: 'organization-created' }]),
      };
    },
  };
}

// These accounts, assignments, permission rows and history match delegation-create.sql and fence.sql.
function assignmentPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal }) => {
      const authorizationRows = permissionRows(route);
      const principalId = newId(route);
      const assignedActorId = newId(route);
      const requestId = newId(route);
      const transactionId = newId(route);
      return {
        ...authorizationRows,
        'access.account': [
          { route, account_id: principalId, kind: 'actor', state: 'active', transaction_id: newId(route) },
          {
            route,
            account_id: assignedActorId,
            kind: 'actor',
            state: 'active',
            transaction_id: newId(route),
          },
        ],
        'access.principal_assignment': [
          {
            route,
            principal_id: principalId,
            creator_principal_id: principalId,
            request_id: requestId,
            assigned_actor_id: assignedActorId,
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

// These accounts, resource rows, permission variants and history match child creation and resource initialization.
function resourceRolePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal }) => {
      const authorizationRows = permissionRows(route);
      const resourceId = newId(route);
      const identityId = newId(route);
      const transactionId = newId(route);
      const initializedAt = '2026-01-01T00:00:00.000Z';
      return {
        ...authorizationRows,
        'access.account': [
          {
            route,
            account_id: identityId,
            kind: 'actor',
            state: 'active',
            transaction_id: newId(route),
          },
        ],
        [resourceTable]: [{ route, id: resourceId, transaction_id: transactionId }],
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
          ...authorizationRows['access.resource_role_grant'],
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
        ...commandHistory(route, ordinal, [
          { kind: 'resource-created', eventType: 'com.rezics.fixture.resource-created.v1' },
        ]),
      };
    },
  };
}

// These accounts, inverse membership holds, fence receipts, permission rows and history match the measured commands.
function coordinationAndFencePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal }) => {
      const authorizationRows = permissionRows(route);
      const accountId = newId(route);
      const reservationId = newId(route);
      const groupId = newId(route);
      const receiptId = newId(route);
      const accountTransactionId = newId(route);
      const holdTransactionId = newId(route);
      const fenceTransactionId = newId(route);
      return {
        ...authorizationRows,
        'access.account': [
          { route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: accountTransactionId },
        ],
        'access.membership_inverse': [
          {
            route,
            account_id: accountId,
            kind: 'organization',
            group_id: groupId,
            reservation_id: reservationId,
            transaction_id: holdTransactionId,
            source_transaction_id: null,
          },
        ],
        'access.lifecycle_coordination': [
          {
            route,
            account_id: accountId,
            reservation_id: reservationId,
            related_account_id: groupId,
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

// These accounts, holds, intervals, slots and history match membership-change writes and the command envelope.
function membershipPopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal }) => {
      const authorizationRows = permissionRows(route);
      const organizationId = newId(route);
      const memberId = newId(route);
      const reservationId = newId(route);
      const transactionId = newId(route);
      return {
        ...authorizationRows,
        'access.account': [
          { route, account_id: organizationId, kind: 'organization', state: 'active', transaction_id: transactionId },
          { route, account_id: memberId, kind: 'actor', state: 'active', transaction_id: transactionId },
        ],
        'access.lifecycle_coordination': [
          {
            route,
            account_id: memberId,
            reservation_id: reservationId,
            related_account_id: organizationId,
            purpose: 'membership',
            transaction_id: transactionId,
          },
        ],
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

// These hashed claims, accounts and receipts match the reserve, claim, redirect and expiry command writes.
function handlePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 0.25,
    finish: commandHistoryFinish(),
    rows: ({ ordinal, route: populationRoute, hot }) => {
      const handle = hot ? handleInPartition(hotPartition, ordinal) : `growth-handle-${ordinal}`;
      const handleRouteValue = hashRoute(handle);
      const accountId = newId(populationRoute);
      const transactionId = newId(handleRouteValue);
      return {
        'access.account': [
          {
            route: populationRoute,
            account_id: accountId,
            kind: 'actor',
            handle,
            state: 'active',
            transaction_id: newId(populationRoute),
          },
        ],
        'access.handle_claim': [
          {
            route: handleRouteValue,
            normalized_handle: handle,
            account_id: accountId,
            state: 'pending',
            expires_at: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
            reserved_until: null,
            transaction_id: transactionId,
            reservation_id: newId(handleRouteValue),
          },
        ],
        ...commandHistory(populationRoute, ordinal, [
          { kind: 'handle-reserved' },
          { kind: 'handle-claimed' },
          { kind: 'handle-redirected' },
          { kind: 'handle-expired' },
        ]),
      };
    },
  };
}

// These accounts, grants, memberships, holds and history match lifecycle creation, tombstoning and fence.sql.
function tombstonePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 1,
    finish: commandHistoryFinish(),
    rows: ({ route, ordinal }) => {
      const authorizationRows = permissionRows(route);
      const accountId = newId(route);
      const ownerId = newId(route);
      const transactionId = newId(route);
      const reservationId = newId(route);
      return {
        ...authorizationRows,
        'access.account': [
          { route, account_id: ownerId, kind: 'actor', state: 'active', transaction_id: newId(route) },
          { route, account_id: accountId, kind: 'organization', state: 'active', transaction_id: transactionId },
        ],
        'access.resource_grant': [
          ...authorizationRows['access.resource_grant'],
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
        'access.lifecycle_coordination': [
          {
            route,
            account_id: ownerId,
            reservation_id: newId(route),
            related_account_id: accountId,
            purpose: 'membership',
            transaction_id: transactionId,
          },
        ],
        'access.lifecycle_fence_receipt': [
          {
            route,
            account_id: accountId,
            receipt_id: newId(route),
            minimum_authn_epoch: 2,
            kind: 'fence',
            prior_operator_account_id: null,
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
  150_000,
);

test.serial(
  'Standing parent installation stays within its bound as Gt grows',
  async () => {
    const partition = 1538;
    const parents: { actor: Awaited<ReturnType<typeof createActor>>; resource: Resource }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const actor = await createActor(partition, `growth_standing_${index}`);
      const resource = { route: accountRoute(actor.accountId), id: actor.accountId };
      await grant(resource, actor.accountId, 'subject:create');
      await grant(resource, actor.accountId, 'access:grant');
      parents.push({ actor, resource });
    }
    const population = grantPopulation(
      'growth-access-standing-parent',
      partition,
      [{ kind: 'standing-parent.install', eventType: 'com.rezics.access.standing-parent.installed.v1' }],
      true,
    );
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const { actor, resource } = parents[repetition]!;
        const context = contextFor(actor.accountId, actor.account);
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
  150_000,
);

test.serial(
  'Creator grant initialization stays within its bound as Gt grows',
  async () => {
    const partition = 1539;
    const creator = await createActor(partition, 'growth_initializer_creator');
    const parent: Resource = { route: accountRoute(creator.accountId), id: creator.accountId };
    await grant(parent, creator.accountId, 'subject:create');
    const context = contextFor(creator.accountId, creator.account);
    const children = Array.from({ length: operationsPerCheck }, () => ({
      route: parent.route,
      id: newId(parent.route),
    }));
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
  150_000,
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
  150_000,
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
  150_000,
);

test.serial(
  'Account and organization creation stays within its bound as A grows',
  async () => {
    const partition = 1542;
    const targets: {
      actorId: string;
      handle: string;
      reservationId: string;
      organizationId: string;
      ownerAccountId: string;
      ownerHold: string;
    }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const owner = await createActor(partition, `growth_creation_owner_${index}`);
      const actorId = newId(partition * 16 + 5);
      const handle = handleInPartition(partition, 400_000 + index);
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
        ownerAccountId: owner.accountId,
        ownerHold: hold.value.reservationId,
      });
    }
    const population = accountDefaultGrantPopulation('growth-access-creations', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const target = targets[repetition]!;
        const pending = await internal.createPending({
          accountId: target.actorId,
          handle: target.handle,
          reservationId: target.reservationId,
          key: `growth-pending-${repetition}`,
        });
        await internal.activate({
          accountId: target.actorId,
          key: `growth-activate-${repetition}`,
          evidence: {
            accountId: target.actorId,
            authIdentityId: target.actorId,
            registrationId: pending.value.registrationId,
            authnEpoch: 1,
          },
        });
        return internal.createOrganization({
          organizationId: target.organizationId,
          ownerAccountId: target.ownerAccountId,
          ownerReservationId: target.ownerHold,
          key: `growth-organization-${repetition}`,
        });
      },
      'Account and organization creation stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  150_000,
);

test.serial(
  'Handle reserve/change/resolve/expire stays within its bound as A grows',
  async () => {
    const partition = 1543;
    const anchors: { handle: string; actor: Awaited<ReturnType<typeof createActor>> }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const handle = handleInPartition(partition, 300_000 + index);
      anchors.push({ handle, actor: await createActor(partition, handle) });
    }
    let instant = new Date(Date.now() + REGISTRATION_TTL_MS + 1);
    const timed = lifecycle(() => new Date(instant));
    for (const { handle } of anchors)
      await timed.expireHandle({ handle, key: `growth-handle-initial-expiry-${handle}` });
    const population = handlePopulation('growth-access-handle-claims', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const { handle, actor } = anchors[repetition]!;
        instant = new Date(Date.now());
        const reservation = await timed.reserveHandle({
          handle,
          accountId: actor.accountId,
          key: `growth-handle-reserve-${repetition}`,
        });
        const pending = await timed.resolveHandle(handle);
        const claim = await timed.claimHandle({
          accountId: actor.accountId,
          handle,
          reservationId: reservation.value.reservationId,
          key: `growth-handle-claim-${repetition}`,
        });
        const active = await timed.resolveHandle(handle);
        const redirect = await timed.redirectHandle({
          accountId: actor.accountId,
          handle,
          key: `growth-handle-redirect-${repetition}`,
        });
        const redirected = await timed.resolveHandle(handle);
        instant = new Date(instant.getTime() + HANDLE_REDIRECT_TTL_MS + 1);
        await timed.expireHandle({ handle, key: `growth-handle-expire-${repetition}` });
        return { pending, claim, active, redirect, redirected, expired: await timed.resolveHandle(handle) };
      },
      'Handle reserve/change/resolve/expire stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  150_000,
);

test.serial(
  'Account update, coordination and fences stays within its bound as A grows',
  async () => {
    const partition = 1544;
    const anchors: {
      actor: Awaited<ReturnType<typeof createActor>>;
      target: Awaited<ReturnType<typeof createActor>>;
    }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const actor = await createActor(partition, `growth_update_actor_${index}`);
      const target = await createActor(partition, `growth_update_target_${index}`);
      await grant({ route: accountRoute(target.accountId), id: target.accountId }, actor.accountId, 'account:update');
      anchors.push({ actor, target });
    }
    const commands = createLifecycleCommands({ pool: db.pool, access });
    const population = coordinationAndFencePopulation('growth-access-account-commands', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const { actor, target } = anchors[repetition]!;
        const ctx = contextFor(actor.accountId, actor.account);
        const update = await commands.updateAccount(ctx, {
          accountId: target.accountId,
          key: `growth-account-update-${repetition}`,
          patch: { displayName: 'growth-update' },
        });
        const hold = await internal.reserveCoordination({
          accountId: actor.accountId,
          relatedAccountId: target.accountId,
          purpose: 'membership',
          key: `growth-coordination-${repetition}`,
        });
        const fence = await internal.raiseFence({
          accountId: target.accountId,
          key: `growth-fence-${repetition}`,
        });
        const receipt = await internal.readFenceReceipt(target.accountId, fence.value.receiptId);
        const state = await internal.readFenceState(target.accountId);
        return { update, hold, fence, receipt, state };
      },
      'Account update, coordination and fences stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  150_000,
);

test.serial(
  'Membership change stays within its bound as m grows',
  async () => {
    const partition = 1545;
    const anchors: {
      owner: Awaited<ReturnType<typeof createActor>>;
      member: Awaited<ReturnType<typeof createActor>>;
      organizationId: string;
      reservationId: string;
    }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const owner = await createActor(partition, `growth_membership_owner_${index}`);
      const member = await createActor(partition, `growth_membership_member_${index}`);
      const organizationId = await organization(owner.accountId, partition);
      const hold = await internal.reserveCoordination({
        accountId: member.accountId,
        relatedAccountId: organizationId,
        purpose: 'membership',
        key: `growth-membership-hold-${index}`,
      });
      anchors.push({ owner, member, organizationId, reservationId: hold.value.reservationId });
    }
    const commands = createLifecycleCommands({ pool: db.pool, access });
    const population = membershipPopulation('growth-access-membership-change', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const target = anchors[repetition]!;
        return commands.setMembership(contextFor(target.owner.accountId, target.owner.account), {
          organizationId: target.organizationId,
          memberAccountId: target.member.accountId,
          reservationId: target.reservationId,
          role: 'member',
          key: `growth-membership-change-${repetition}`,
        });
      },
      'Membership change stays within its bound as m grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  150_000,
);

test.serial(
  'Tombstone erasure stays within its bound as m grows',
  async () => {
    const partition = 1546;
    const actor = await createActor(partition, 'growth_tombstone_actor');
    const targets: string[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
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
  150_000,
);
