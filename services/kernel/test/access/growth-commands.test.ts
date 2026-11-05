import { resetGrowthTables } from './growth-reset.ts';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { readAccount, readOrganizationRole, readPublicAccount } from '../../src/access/account-data.ts';
import { createDelegationCommands, readAssignment } from '../../src/access/delegation-commands.ts';
import { createGrantCommands, GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  HANDLE_REDIRECT_TTL_MS,
  LifecycleDeniedError,
  REGISTRATION_TTL_MS,
} from '../../src/access/lifecycle.ts';
import {
  initializeResourceGrants,
  installStandingParentGrant,
  parentCreationAuthorization,
} from '../../src/access/index.ts';
import { runCommand } from '../../src/command/command.ts';
import { accessCommandAuthorization, type ActionCatalogue, type Resource } from '../../src/request/access.ts';
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
// Budget the 34,000 generated ordinals at 20 ms each under concurrent gates,
// plus up to twelve native 3 s boundaries for every warm-up/measured operation.
const growthTimeout = (baselineOrdinals + 64 * ordinalsPerScale) * 20 + operationsPerCheck * 12 * 3000;
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
const access = admittedAccess({ actions });

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
  return { accountId, account };
}

async function contextFor(accountId: string, account: NonNullable<Awaited<ReturnType<typeof readAccount>>>) {
  return {
    pool: db.pool,
    deadline: Date.now() + 30_000,
    account,
    actor: await authenticateAccount(
      access,
      { pool: db.pool, deadline: Date.now() + 30_000 },
      {
        accountId,
        clientId: 'growth-access-test',
        scopes: [...actions.keys()],
        requestedBy: null,
        authnEpoch: Number(account.minimumAuthnEpoch),
      },
    ),
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
    const report = await checkGrowth(db, {
      name,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (growthDb, scale, previous) => {
        if (previous === 0)
          await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
            from: 100_000,
            to: 100_000 + baselineOrdinals,
          });
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
  await resetGrowthTables(db.admin, [
    'core.receipt',
    'core.outbox',
    'editorial.write_basis',
    'access.account',
    'access.handle_claim',
    'access.lifecycle_coordination',
    'access.lifecycle_fence_receipt',
    'access.lifecycle_membership_slot',
    'access.membership_inverse',
    'access.organization_member',
    'access.principal_assignment',
    'access.resource_denial',
    'access.resource_grant',
    'access.resource_initialization',
    'access.resource_role_grant',
    'access.standing_parent_installation',
    resourceTable,
  ]);
  await db.admin.query('UPDATE core.partition SET position = 0');
  await db.admin.query('CHECKPOINT');
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
      const handle = hot ? hotHandle(hotPartition, 200_000 + ordinal) : `growth-account-handle-${ordinal}`;
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
        'access.membership_inverse': [
          {
            route,
            account_id: newId(route),
            kind: 'organization',
            group_id: newId(route),
            reservation_id: newId(route),
            transaction_id: transactionId,
          },
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

// Hashes that land in a partition cannot be derived, only searched for, at about 4,096 hashes each. A script that is
// not committed searched once: for each ordinal that reaches hotHandle it kept the first attempt whose handle lands in
// the partition. The attempts are 16-bit little-endian values: the seeded ordinals in order, the baseline ordinals,
// then the measured ones. Each handle is verified with one hash when it is built.
const hotHandleFixtures: Record<number, { seeded: number; measured: number; attempts: Buffer }> = {
  1542: {
    seeded: 200_000,
    measured: 400_000,
    attempts: Buffer.from(
      [
        '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',
        'CmgAdBzOBEEDWgxJDQQX4zwNAK4cLxM=',
      ].join(''),
      'base64',
    ),
  },
  1543: {
    seeded: 0,
    measured: 300_000,
    attempts: Buffer.from(
      [
        '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',
        'G/gASAgRHXwGvBlfAosNZAPWCYIZ7AY=',
      ].join(''),
      'base64',
    ),
  },
};

function hotHandleIndex(seeded: number, measured: number, ordinal: number): number | undefined {
  const seededOffset = ordinal - seeded;
  const hot = seededOffset % 4 === 3;
  if (hot && seededOffset >= 0 && seededOffset < ordinalsPerScale * 64) return seededOffset >> 2;
  const baselineOffset = seededOffset - 100_000;
  if (hot && baselineOffset >= 0 && baselineOffset < baselineOrdinals)
    return (ordinalsPerScale * 64) / 4 + (baselineOffset >> 2);
  const measuredOffset = ordinal - measured;
  if (measuredOffset >= 0 && measuredOffset < operationsPerCheck)
    return (ordinalsPerScale * 64 + baselineOrdinals) / 4 + measuredOffset;
  return undefined;
}

function hotHandle(partition: number, ordinal: number, hash: (value: string) => number = hashRoute): string {
  const fixture = hotHandleFixtures[partition];
  const index = fixture && hotHandleIndex(fixture.seeded, fixture.measured, ordinal);
  if (!fixture || index === undefined)
    throw new RangeError(`No hot handle is recorded for partition ${partition} and ordinal ${ordinal}`);
  const attempt = fixture.attempts.readUInt16LE(index * 2);
  const handle = `g${ordinal.toString(16).padStart(8, '0')}x${attempt.toString(16).padStart(8, '0')}`;
  if (hash(handle) >>> 4 !== partition)
    throw new Error(`Recorded hot handle ${handle} is not in partition ${partition}`);
  return handle;
}

// These hashed claims, accounts and receipts match the reserve, claim, redirect and expiry command writes.
function handlePopulation(name: string, hotPartition: number): Population {
  return {
    name,
    hotPartition,
    hotShare: 0.25,
    finish: commandHistoryFinish(),
    rows: ({ ordinal, route: populationRoute, hot }) => {
      const handle = hot ? hotHandle(hotPartition, ordinal) : `growth-handle-${ordinal}`;
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

test('hot-partition handles are deterministic and cost at most one partition hash each', () => {
  const cases: [number, number[]][] = [
    [1542, [200_003, 231_999, 300_003, 301_999, 400_000, 400_017]],
    [1543, [3, 31_999, 100_003, 101_999, 300_000, 300_017]],
  ];
  for (const [partition, ordinals] of cases) {
    let calls = 0;
    const counted = (value: string): number => {
      calls++;
      return hashRoute(value);
    };
    const first = ordinals.map((ordinal) => hotHandle(partition, ordinal, counted));
    const second = ordinals.map((ordinal) => hotHandle(partition, ordinal, counted));
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    for (const handle of first) expect(hashRoute(handle) >>> 4).toBe(partition);
    expect(calls).toBeLessThanOrEqual(2 * first.length);
  }
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
  growthTimeout,
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
        const context = await contextFor(actor.accountId, actor.account);
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
  growthTimeout,
);

test.serial(
  'Creator grant initialization stays within its bound as Gt grows',
  async () => {
    const partition = 1539;
    const creator = await createActor(partition, 'growth_initializer_creator');
    const parent: Resource = { route: accountRoute(creator.accountId), id: creator.accountId };
    await grant(parent, creator.accountId, 'subject:create');
    const context = await contextFor(creator.accountId, creator.account);
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
  growthTimeout,
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
    const context = await contextFor(actor.accountId, actor.account);
    const recipientId = newId(resource.route);
    const population = grantPopulation('growth-access-grant-commands', partition, [
      { kind: 'grant.create' },
      { kind: 'grant.change' },
      { kind: 'grant.revoke' },
    ]);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const ctx = await contextFor(actor.accountId, actor.account);
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
  growthTimeout,
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
        const ctx = await contextFor(principal.accountId, principal.account);
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
  growthTimeout,
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
      const handle = hotHandle(partition, 400_000 + index);
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
  growthTimeout,
);

test.serial(
  'Handle reserve/change/resolve/expire stays within its bound as A grows',
  async () => {
    const partition = 1543;
    const anchors: { handle: string; actor: Awaited<ReturnType<typeof createActor>> }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const handle = hotHandle(partition, 300_000 + index);
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
        await expect(timed.expireHandle({ handle, key: `growth-handle-expire-${repetition}` })).rejects.toBeInstanceOf(
          LifecycleDeniedError,
        );
        return { pending, claim, active, redirect, redirected, expired: await timed.resolveHandle(handle) };
      },
      'Handle reserve/change/resolve/expire stays within its bound as A grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  growthTimeout,
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
        const ctx = await contextFor(actor.accountId, actor.account);
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
  growthTimeout,
);

test.serial(
  'Membership change stays within its bound as m grows',
  async () => {
    const partition = 1545;
    // Keep the authorization resource and authority fixed across scales.
    // Every warm-up and capture still performs a fresh native membership write.
    const owner = await createActor(partition, 'growth_membership_owner');
    const organizationId = await organization(owner.accountId, partition);
    const anchors: {
      member: Awaited<ReturnType<typeof createActor>>;
      reservationId: string;
    }[] = [];
    for (let index = 0; index < operationsPerCheck; index++) {
      const member = await createActor(partition, `growth_membership_member_${index}`);
      const hold = await internal.reserveCoordination({
        accountId: member.accountId,
        relatedAccountId: organizationId,
        purpose: 'membership',
        key: `growth-membership-hold-${index}`,
      });
      anchors.push({ member, reservationId: hold.value.reservationId });
    }
    const commands = createLifecycleCommands({ pool: db.pool, access });
    const population = membershipPopulation('growth-access-membership-change', partition);
    const report = await check(
      population,
      async (_growthDb, _scale, repetition) => {
        const target = anchors[repetition]!;
        return commands.setMembership(await contextFor(owner.accountId, owner.account), {
          organizationId,
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
  growthTimeout,
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
        commands.tombstone(await contextFor(actor.accountId, actor.account), {
          accountId: targets[repetition]!,
          key: `growth-tombstone-${repetition}`,
        }),
      'Tombstone erasure stays within its bound as m grows',
    );
    expect(report.samples).toHaveLength(3);
  },
  growthTimeout,
);
