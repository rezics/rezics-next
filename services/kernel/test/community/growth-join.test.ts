import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient } from 'pg';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { durableInitiatorCommitment } from '../../src/access/durable-initiator-capture.ts';
import { createAccountsWorkModule } from '../../src/access/membership-work.ts';
import {
  createRealmMembership,
  membershipSourceDigest,
  readMembershipInitiator,
  type MembershipOperationFacts,
} from '../../src/community/membership.ts';
import { createCommunityWorkModule } from '../../src/community/work.ts';

const communityWorkModule = createCommunityWorkModule({ deadlineNow: () => Date.now() });
import { createKernel } from '../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { systemClock } from '../../src/clock.ts';
import { registerEffects, type Effect } from '../../src/events/effects.ts';
import { DBOS_SCHEMA, WORK_APPLICATION, createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkContext, WorkService } from '../../src/work/registry.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import resourceRoles from '../../src/access/resource-roles.json';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type GrowthReport,
} from '../support/growth.ts';
import { createProductionAccess } from './membership-fixture.ts';

const probeRoute = 0x2130;
const hotPartition = partitionOf(probeRoute);
const created = '2020-01-01 00:00:00+00';
const history = '[2018-01-01 00:00:00+00,2020-01-01 00:00:00+00)';
const opened = '[2020-01-01 00:00:00+00,)';
const scales = [1, 4, 16] as const;
const rowsPerScale = 500;
const candidatesPerCheck = 18;
const memberScopes = ['realm:join', 'realm:read'];
const managerScopes = ['realm:manage', 'realm:read'];
const accessActions = [...new Set(Object.values(resourceRoles.roles).flat())];
const routeKey = new Uint8Array(32).fill(91);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const membershipClientId = 'realm-growth';
const nilId = '00000000-0000-0000-0000-000000000000';

type Realm = { realmId: string; spaceId: string; visibility: 'public' | 'protected' };
type SeedIds = {
  candidateId: string;
  targetMemberId: string;
  otherMemberId: string;
  otherSpaceId: string;
  otherRealmId: string;
};
type Candidate = { accountId: string; bearer: string };
type CallOptions = { bearer?: string; body?: unknown; key?: string };

let db: GrowthDatabase;
let work: WorkClient;
let systemPool: Pool;
let workServices: WorkService[] = [];
let kernel: ReturnType<typeof createKernel>;
let production: Awaited<ReturnType<typeof createProductionAccess>>;
let ownerId: string;
let publicRealm: Realm;
let protectedRealm: Realm;
let ownerBearer = '';

type NativeGrowthContext = {
  check: string;
  scale: number;
  repetition: number;
  phase: 'warmup' | 'measured';
};

function observeNativeGrowthPlans(database: GrowthDatabase): {
  run<T>(context: NativeGrowthContext, operation: () => Promise<T>): Promise<T>;
  flush(): void;
} {
  if (process.env.CONTENT_GROWTH_NATIVE_PLANS !== '1')
    return {
      run<T>(_context: NativeGrowthContext, operation: () => Promise<T>): Promise<T> {
        return operation();
      },
      flush() {
        return undefined;
      },
    };

  const file = '.temp/content-growth-native-plans.jsonl';
  const plans: Array<
    NativeGrowthContext & {
      statement: string | null;
      nativePlanJson: string;
      nativeNotice: string;
    }
  > = [];
  const attached = new WeakSet<PoolClient>();
  let context: NativeGrowthContext | undefined;
  let flushed = false;

  const onAcquire = (client: PoolClient): void => {
    if (attached.has(client)) return;
    attached.add(client);
    client.on('notice', (notice) => {
      const current = context;
      const message = notice.message;
      const marker = 'plan:\n';
      if (!current || typeof message !== 'string' || !message.startsWith('duration:') || !message.includes(marker))
        return;
      const nativePlanJson = message.slice(message.indexOf(marker) + marker.length);
      let statement: string | null = null;
      try {
        const parsed = JSON.parse(nativePlanJson) as unknown;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        const query = entries.find(
          (entry): entry is Record<string, unknown> =>
            typeof entry === 'object' &&
            entry !== null &&
            !Array.isArray(entry) &&
            typeof entry['Query Text'] === 'string',
        );
        if (query) statement = query['Query Text'] as string;
      } catch {
        // Retain the original notice even if PostgreSQL emits an unexpected plan document.
      }
      plans.push({
        ...current,
        statement,
        nativePlanJson,
        nativeNotice: message,
      });
    });
  };

  database.pool.on('acquire', onAcquire);
  return {
    async run<T>(next: NativeGrowthContext, operation: () => Promise<T>): Promise<T> {
      const previous = context;
      context = next;
      try {
        return await operation();
      } finally {
        context = previous;
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      database.pool.removeListener('acquire', onAcquire);
      if (plans.length === 0) {
        process.stdout.write('CONTENT_GROWTH_NATIVE_PLANS captured 0 notices\n');
        return;
      }
      mkdirSync('.temp', { recursive: true });
      const jsonl = `${plans.map((plan) => JSON.stringify(plan)).join('\n')}\n`;
      appendFileSync(file, jsonl);
      process.stdout.write(`CONTENT_GROWTH_NATIVE_PLANS file=${file} records=${plans.length}\n`);
      process.stdout.write(`CONTENT_GROWTH_NATIVE_PLANS_BEGIN\n${jsonl}CONTENT_GROWTH_NATIVE_PLANS_END\n`);
    },
  };
}

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  let value: Record<string, unknown> = {};
  try {
    value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    value = { body: text };
  }
  return { response, value };
}

async function complete(workflowId: string): Promise<void> {
  expect(await work.retrieveWorkflow(workflowId).getResult()).toBeUndefined();
}

async function verifyMembership(realmId: string, accountId: string, present: boolean): Promise<void> {
  const result = await db.admin.query(
    `SELECT 1 FROM community.realm_member
      WHERE route = $1 AND realm_id = $2 AND account_id = $3 AND upper_inf(valid)`,
    [routeOf(realmId), realmId, accountId],
  );
  expect(result.rowCount === 1).toBe(present);
}

async function verifyFollow(accountId: string, spaceId: string): Promise<void> {
  const result = await db.admin.query<{ target_type: string; state: string; reason: string }>(
    `SELECT target_type, state, reason FROM library.follow WHERE route = $1 AND account_id = $2 AND target_id = $3`,
    [routeOf(accountId), accountId, spaceId],
  );
  expect(result.rows).toEqual([{ target_type: 'space', state: 'following', reason: 'membership' }]);
}

async function prepareBaseRealm(realm: Realm, creator: string, revisionId: string): Promise<void> {
  const route = routeOf(realm.realmId)!;
  const spaceRevisionId = newId(route);
  const transactionId = newId(route);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
      [route, realm.spaceId, spaceRevisionId, created, creator],
    );
    await client.query(
      `INSERT INTO community.space_revision
         (route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Growth host', '', $4, $5)`,
      [route, realm.spaceId, spaceRevisionId, created, creator],
    );
    await client.query(
      `INSERT INTO community.realm
         (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8)`,
      [route, realm.realmId, realm.spaceId, realm.visibility, GLOBAL_CONTEXT, revisionId, created, creator],
    );
    await client.query(
      `INSERT INTO community.realm_revision
         (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Growth Realm', '', $4, $5, $6, $7)`,
      [route, realm.realmId, revisionId, realm.visibility, GLOBAL_CONTEXT, created, creator],
    );
    await client.query(
      `INSERT INTO access.resource_initialization
         (route, resource_id, resource_type, creator_id, initialized_at)
       VALUES ($1, $2, 'community.space', $3, $4), ($1, $5, 'community.realm', $3, $4)`,
      [route, realm.spaceId, creator, created, realm.realmId],
    );
    await client.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES
         ($1, $2, 'active_accounts', $3, '', 'community.realm.standing', '(,)', $4),
         ($1, $2, 'identity', $5, '', 'community.realm.owner', '(,)', $4)`,
      [route, realm.realmId, nilId, transactionId, creator],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function installBaseRows(): Promise<void> {
  ownerId = newId(probeRoute);
  publicRealm = { realmId: newId(probeRoute), spaceId: newId(probeRoute), visibility: 'public' };
  protectedRealm = { realmId: newId(probeRoute), spaceId: newId(probeRoute), visibility: 'protected' };
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [routeOf(ownerId), ownerId],
  );
  await prepareBaseRealm(publicRealm, ownerId, newId(probeRoute));
  await prepareBaseRealm(protectedRealm, ownerId, newId(probeRoute));
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 10;
  db.pool.options.connectionTimeoutMillis = 10_000;

  let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] = async () => null;
  production = await createProductionAccess({
    actions: accessActions,
    realmRoleReader: (client, input) => roleReader(client, input),
  });
  const apiMembership = createRealmMembership({ pool: db.pool, access: production.access, referenceKeys: tokens });
  roleReader = apiMembership.roleReader;

  const workerMembership = createRealmMembership({
    pool: db.pool,
    access: production.access,
    referenceKeys: tokens,
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: production.access,
      readOperation: readMembershipInitiator,
      async readConsent({ actorAccountId, clientId }) {
        return { actorAccountId, clientId, scopes: accessActions };
      },
    }),
  });
  systemPool = new Pool({ connectionString: db.url, max: 10 });
  work = await createWorkClient(db.url, systemPool);
  const workerEnv = {
    KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.from(tokens.keys.get(1)!).toString('base64url')}`,
    AUTH_ISSUER: 'https://realm-growth.auth.test',
    AUTH_AUDIENCE: 'https://realm-growth.api.test',
    AUTH_JWKS_URL: 'https://realm-growth.auth.test/.well-known/jwks.json',
  };
  DBOS.setConfig({
    name: WORK_APPLICATION,
    systemDatabaseUrl: db.url,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    systemDatabasePool: systemPool,
    runMigrations: false,
    logLevel: 'warn',
    executorID: 'realm-growth-check',
  });
  for (const [name, parameters] of Object.entries(WORK_QUEUES)) await work.registerQueue(name, parameters);
  const effects: Effect[] = [];
  const starters: Array<() => WorkService | Promise<WorkService>> = [];
  const context: WorkContext = Object.freeze({
    pool: db.pool,
    queues: WORK_QUEUES,
    client: work,
    env: workerEnv,
    clock: systemClock,
    getAuthorization() {
      throw new Error('Realm growth fixture supplies its membership adapter directly');
    },
    addEffects(items) {
      effects.push(...items);
    },
    addService(start) {
      starters.push(start);
    },
  });
  await createAccountsWorkModule({ realm: workerMembership }).register(context);
  await communityWorkModule.register(context);
  registerEffects(effects);
  await DBOS.launch();
  workServices = [];
  for (const start of starters) workServices.push(await start());

  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    workClient: work,
    access: production.access,
    writeRate: createWriteRateLimiter({ secret: 'realm-growth-check-write-rate-secret-32' }),
  });
  await installBaseRows();
}, 120_000);

afterAll(async () => {
  try {
    for (let index = workServices.length - 1; index >= 0; index--) await workServices[index]!.stop();
    if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 2_147_483_647 });
  } finally {
    await work?.close();
    await systemPool?.end();
    await db?.close();
  }
});

function makePopulation(name: string, target: Realm, positionBase: number) {
  const ids = new Map<number, SeedIds>();
  const population: Population = {
    name,
    hotPartition,
    hotShare: 0.5,
    rows({ route: otherRoute, ordinal }) {
      const targetAccountRoute = hotPartition * 16 + (ordinal % 16);
      const candidateId = newId(targetAccountRoute);
      const targetMemberId = newId(targetAccountRoute);
      const otherMemberId = newId(otherRoute);
      const otherSpaceId = newId(otherRoute);
      const otherRealmId = newId(otherRoute);
      const spaceRevisionId = newId(otherRoute);
      const realmRevisionId = newId(otherRoute);
      const oldTargetReservation = newId(targetAccountRoute);
      const currentTargetReservation = newId(targetAccountRoute);
      const oldOtherReservation = newId(otherRoute);
      const currentOtherReservation = newId(otherRoute);
      const oldTargetTransaction = newId(probeRoute);
      const currentTargetTransaction = newId(probeRoute);
      const operationId = newId(probeRoute);
      const operationTransaction = newId(probeRoute);
      const oldOtherTransaction = newId(otherRoute);
      const currentOtherTransaction = newId(otherRoute);
      const otherRealmTransaction = newId(otherRoute);
      const followTransaction = newId(targetAccountRoute);
      const coordinationAccountId = newId(targetAccountRoute);
      const coordinationReservationId = newId(targetAccountRoute);
      const coordinationTransactionId = newId(targetAccountRoute);
      const position = positionBase + ordinal * 100 + 1;
      const operationKey = `${name}-${ordinal}`;
      const operationRequestDigest = Buffer.alloc(32, ordinal % 256).toString('hex');
      const operation = {
        route: probeRoute,
        id: operationId,
        kind: 'community.realm.join',
        sourceId: operationId,
      } as const;
      const operationTarget = { route: probeRoute, id: target.realmId } as const;
      const operationFacts: MembershipOperationFacts = {
        realmId: target.realmId,
        spaceId: target.spaceId,
        memberAccountId: targetMemberId,
        reservationId: null,
        banId: null,
      };
      const operationRecord = {
        operation,
        initiatorAccountId: targetMemberId,
        actor: {
          kind: 'account' as const,
          accountId: targetMemberId,
          clientId: membershipClientId,
          scopes: memberScopes,
          requestedBy: null,
          authnEpoch: 1,
        },
        recordedTransactionId: operationTransaction,
        sourceDigest: membershipSourceDigest(operation, operationTarget, operationFacts),
        originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null },
        originalDelegation: null,
        creation: {
          commandKind: operation.kind,
          idempotencyKey: operationKey,
          requestDigest: operationRequestDigest,
          target: operationTarget,
        },
      };
      const details = { candidateId, targetMemberId, otherMemberId, otherSpaceId, otherRealmId };
      ids.set(ordinal, details);

      const memberIntervals = [
        {
          route: probeRoute,
          realm_id: target.realmId,
          account_id: targetMemberId,
          role: 'member',
          valid: history,
          reservation_id: oldTargetReservation,
          transaction_id: oldTargetTransaction,
        },
        {
          route: probeRoute,
          realm_id: target.realmId,
          account_id: targetMemberId,
          role: 'member',
          valid: opened,
          reservation_id: currentTargetReservation,
          transaction_id: currentTargetTransaction,
        },
        {
          route: otherRoute,
          realm_id: otherRealmId,
          account_id: otherMemberId,
          role: 'member',
          valid: history,
          reservation_id: oldOtherReservation,
          transaction_id: oldOtherTransaction,
        },
        {
          route: otherRoute,
          realm_id: otherRealmId,
          account_id: otherMemberId,
          role: 'member',
          valid: opened,
          reservation_id: currentOtherReservation,
          transaction_id: currentOtherTransaction,
        },
      ];
      const memberTerminals = [
        {
          route: probeRoute,
          realm_id: target.realmId,
          account_id: targetMemberId,
          reservation_id: oldTargetReservation,
          transaction_id: oldTargetTransaction,
          at: created,
        },
        {
          route: otherRoute,
          realm_id: otherRealmId,
          account_id: otherMemberId,
          reservation_id: oldOtherReservation,
          transaction_id: oldOtherTransaction,
          at: created,
        },
      ];
      const inverseRows = [
        {
          route: targetAccountRoute,
          account_id: targetMemberId,
          kind: 'realm',
          group_id: target.realmId,
          reservation_id: currentTargetReservation,
          transaction_id: currentTargetTransaction,
          source_transaction_id: currentTargetTransaction,
        },
        {
          route: otherRoute,
          account_id: otherMemberId,
          kind: 'realm',
          group_id: otherRealmId,
          reservation_id: currentOtherReservation,
          transaction_id: currentOtherTransaction,
          source_transaction_id: currentOtherTransaction,
        },
      ];
      const inverseTerminals = [
        {
          route: targetAccountRoute,
          account_id: targetMemberId,
          kind: 'realm',
          group_id: target.realmId,
          reservation_id: oldTargetReservation,
          reservation_transaction_id: oldTargetTransaction,
          proof_transaction_id: oldTargetTransaction,
          transaction_id: oldTargetTransaction,
        },
        {
          route: otherRoute,
          account_id: otherMemberId,
          kind: 'realm',
          group_id: otherRealmId,
          reservation_id: oldOtherReservation,
          reservation_transaction_id: oldOtherTransaction,
          proof_transaction_id: oldOtherTransaction,
          transaction_id: oldOtherTransaction,
        },
      ];
      const roleGrants = [
        {
          route: otherRoute,
          resource_id: otherRealmId,
          subject_kind: 'active_accounts',
          subject_id: nilId,
          subject_role: '',
          grant_role: 'community.realm.standing',
          valid: '(,)',
          transaction_id: otherRealmTransaction,
        },
        {
          route: otherRoute,
          resource_id: otherRealmId,
          subject_kind: 'identity',
          subject_id: otherMemberId,
          subject_role: '',
          grant_role: 'community.realm.owner',
          valid: '(,)',
          transaction_id: otherRealmTransaction,
        },
        {
          route: otherRoute,
          resource_id: otherRealmId,
          subject_kind: 'identity',
          subject_id: otherMemberId,
          subject_role: '',
          grant_role: 'community.realm.member',
          valid: '(,)',
          transaction_id: otherRealmTransaction,
        },
      ];
      if (target.visibility === 'protected')
        roleGrants.push({
          route: probeRoute,
          resource_id: target.realmId,
          subject_kind: 'identity',
          subject_id: targetMemberId,
          subject_role: '',
          grant_role: 'community.realm.member',
          valid: '(,)',
          transaction_id: currentTargetTransaction,
        });

      return {
        'access.account': [
          {
            route: targetAccountRoute,
            account_id: candidateId,
            kind: 'actor',
            state: 'active',
            transaction_id: candidateId,
          },
          {
            route: targetAccountRoute,
            account_id: targetMemberId,
            kind: 'actor',
            state: 'active',
            transaction_id: targetMemberId,
          },
          {
            route: targetAccountRoute,
            account_id: coordinationAccountId,
            kind: 'actor',
            state: 'active',
            transaction_id: coordinationAccountId,
          },
          {
            route: otherRoute,
            account_id: otherMemberId,
            kind: 'actor',
            state: 'active',
            transaction_id: otherMemberId,
          },
        ],
        'community.space': [
          {
            route: otherRoute,
            space_id: otherSpaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: created,
            creator: otherMemberId,
          },
        ],
        'community.space_revision': [
          {
            route: otherRoute,
            space_id: otherSpaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: 'Growth neighbour',
            summary: '',
            created_at: created,
            author: otherMemberId,
          },
        ],
        'community.realm': [
          {
            route: otherRoute,
            realm_id: otherRealmId,
            space_id: otherSpaceId,
            state: 'active',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: realmRevisionId,
            created_at: created,
            creator: otherMemberId,
          },
        ],
        'community.realm_revision': [
          {
            route: otherRoute,
            realm_id: otherRealmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: 'Growth neighbour',
            summary: '',
            visibility: 'protected',
            context_id: GLOBAL_CONTEXT,
            created_at: created,
            author: otherMemberId,
          },
        ],
        'community.realm_member': memberIntervals,
        'community.realm_member_terminal': memberTerminals,
        'community.realm_membership_operation': [
          {
            route: probeRoute,
            operation_id: operationId,
            kind: 'join',
            realm_id: target.realmId,
            space_id: target.spaceId,
            member_account_id: targetMemberId,
            reservation_id: null,
            ban_id: null,
            initiator_account_id: targetMemberId,
            actor_client_id: membershipClientId,
            actor_scopes: memberScopes,
            actor_requested_by: null,
            actor_authn_epoch: 1,
            requested_at: created,
            recorded_transaction_id: operationTransaction,
            source_digest: operationRecord.sourceDigest,
            original_minimum_authn_epoch: '1',
            original_operator_account_id: null,
            original_delegation_transaction_id: null,
            original_delegation_issued_valid: null,
            creation_command_kind: operation.kind,
            creation_idempotency_key: operationKey,
            creation_request_digest: operationRequestDigest,
            creation_target_route: probeRoute,
            creation_target_id: target.realmId,
          },
        ],
        'community.realm_ban': [
          {
            route: otherRoute,
            realm_id: otherRealmId,
            account_id: candidateId,
            valid: opened,
            reason: 'Growth neighbour ban',
            actor: otherMemberId,
            transaction_id: otherRealmTransaction,
          },
        ],
        'access.resource_initialization': [
          {
            route: otherRoute,
            resource_id: otherSpaceId,
            resource_type: 'community.space',
            creator_id: otherMemberId,
            initialized_at: created,
          },
          {
            route: otherRoute,
            resource_id: otherRealmId,
            resource_type: 'community.realm',
            creator_id: otherMemberId,
            initialized_at: created,
          },
        ],
        'access.resource_role_grant': roleGrants,
        'access.resource_grant': [
          {
            route: otherRoute,
            resource_id: otherRealmId,
            subject_kind: 'identity',
            subject_id: candidateId,
            subject_role: '',
            action: 'realm:join',
            valid: '(,)',
            transaction_id: otherRealmTransaction,
          },
          {
            route: probeRoute,
            resource_id: target.realmId,
            subject_kind: 'identity',
            subject_id: candidateId,
            subject_role: '',
            action: 'realm:join',
            valid: '(,)',
            transaction_id: currentTargetTransaction,
          },
          {
            route: probeRoute,
            resource_id: target.realmId,
            subject_kind: 'identity',
            subject_id: candidateId,
            subject_role: '',
            action: 'realm:read',
            valid: '(,)',
            transaction_id: currentTargetTransaction,
          },
          {
            route: probeRoute,
            resource_id: target.realmId,
            subject_kind: 'identity',
            subject_id: targetMemberId,
            subject_role: '',
            action: 'realm:read',
            valid: '(,)',
            transaction_id: currentTargetTransaction,
          },
        ],
        'access.resource_denial': [
          {
            route: otherRoute,
            resource_id: otherRealmId,
            subject_id: candidateId,
            subject_role: '',
            action: 'realm:join',
            reason: 'realm_ban',
            valid: opened,
            transaction_id: otherRealmTransaction,
          },
          {
            route: otherRoute,
            resource_id: otherRealmId,
            subject_id: candidateId,
            subject_role: '',
            action: 'realm:participate',
            reason: 'realm_ban',
            valid: opened,
            transaction_id: otherRealmTransaction,
          },
        ],
        'access.membership_inverse': inverseRows,
        'access.membership_inverse_terminal': inverseTerminals,
        'access.lifecycle_coordination': [
          {
            route: targetAccountRoute,
            account_id: coordinationAccountId,
            reservation_id: coordinationReservationId,
            related_account_id: otherMemberId,
            purpose: 'membership',
            transaction_id: coordinationTransactionId,
          },
        ],
        'library.follow': [
          {
            route: targetAccountRoute,
            account_id: targetMemberId,
            target_id: target.spaceId,
            target_type: 'space',
            state: 'following',
            reason: 'membership',
            created_at: created,
            updated_at: created,
            transaction_id: currentTargetTransaction,
          },
          {
            route: targetAccountRoute,
            account_id: candidateId,
            target_id: otherSpaceId,
            target_type: 'space',
            state: 'following',
            reason: 'membership',
            created_at: created,
            updated_at: created,
            transaction_id: followTransaction,
          },
        ],
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_kind: 'account',
            principal_id: targetMemberId,
            command_kind: operation.kind,
            idempotency_key: operationKey,
            request_digest: Buffer.from(operationRequestDigest, 'hex'),
            epoch: 1,
            position,
            transaction_id: operationTransaction,
            response: { durableInitiator: durableInitiatorCommitment(operationRecord) },
          },
        ],
        'core.outbox': [
          {
            partition_no: hotPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(probeRoute),
            type: 'com.rezics.community.realm.membership.requested.v1',
            subject: target.realmId,
            data: {
              realmId: target.realmId,
              accountId: targetMemberId,
              operationId,
              kind: 'join',
              at: created,
              transactionId: operationTransaction,
            },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: hotPartition,
            transaction_id: operationTransaction,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: targetMemberId,
            client_id: membershipClientId,
            requested_by: null,
            recorded_at: created,
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
  return {
    population,
    ids,
    async candidates(kind: 'new' | 'member', scopes: readonly string[]): Promise<Candidate[]> {
      return Promise.all(
        Array.from({ length: candidatesPerCheck }, async (_, ordinal) => {
          const value = ids.get(ordinal);
          if (!value) throw new Error(`Missing seeded Realm member ${ordinal}`);
          const accountId = kind === 'member' ? value.targetMemberId : value.candidateId;
          return { accountId, bearer: await production.mint(accountId, scopes, membershipClientId) };
        }),
      );
    },
  };
}

async function partitionPosition(): Promise<number> {
  const result = await db.admin.query<{ position: string }>(
    'SELECT position::text FROM core.partition WHERE partition_no = $1',
    [hotPartition],
  );
  return Number(result.rows[0]?.position ?? 0);
}

async function assertCommunityPlans(report: GrowthReport): Promise<void> {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    const relations = Object.entries(sample.cost.relations).filter(([name]) => name.startsWith('community.'));
    expect(relations.length).toBeGreaterThan(0);
    for (const [, cost] of relations) expect(cost.sequentialScans).toBe(0);
  }
}

function showSamples(title: string, report: GrowthReport): void {
  console.info(
    `GROWTH_SAMPLES ${title} ${JSON.stringify(
      report.samples.map(({ scale, cost, seeding }) => ({
        scale,
        rows: cost.rows,
        statements: cost.statements,
        blocks: cost.blocks,
        seeding,
      })),
    )}`,
  );
}

async function growPopulation(
  population: Population,
  scale: number,
  previous: number,
  candidates: () => Promise<Candidate[]>,
  scopes: readonly string[],
): Promise<Candidate[]> {
  await seed(db, population, { from: previous * rowsPerScale, to: scale * rowsPerScale });
  const actors = await candidates();
  if (scopes === managerScopes) ownerBearer = await production.mint(ownerId, managerScopes, membershipClientId);
  for (let index = 0; index < actors.length; index++) {
    if (!actors[index]) throw new Error(`Missing prepared membership actor ${index}`);
  }
  return actors;
}

test.serial(
  'Join a Realm has constant rows and statements as Realms and its members grow',
  async () => {
    const base = await partitionPosition();
    const fixture = makePopulation('realm-join-neighbours', publicRealm, base);
    let actors: Candidate[] = [];
    const report = await checkGrowth(db, {
      name: 'Join a Realm',
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        actors = await growPopulation(
          fixture.population,
          scale,
          previous,
          () => fixture.candidates('new', memberScopes),
          memberScopes,
        );
      },
      async warmup(_database, _scale, repetition) {
        await runJoin(actors[repetition]!);
      },
      async operation(_database, _scale, repetition) {
        await runJoin(actors[repetition]!);
      },
    });
    await assertCommunityPlans(report);
    showSamples('Join a Realm', report);

    async function runJoin(actor: Candidate): Promise<void> {
      const result = await call('POST', `/v1/realms/${publicRealm.realmId}/membership`, {
        bearer: actor.bearer,
        key: crypto.randomUUID(),
      });
      expect(result.response.status, JSON.stringify(result.value)).toBe(202);
      const workflowId = String(result.value.workflowId);
      expect(workflowId).toMatch(/^community\.join:[0-9a-f]{32}$/);
      await complete(workflowId);
      await verifyMembership(publicRealm.realmId, actor.accountId, true);
      await verifyFollow(actor.accountId, publicRealm.spaceId);
    }
  },
  600_000,
);

test.serial(
  'Leave a Realm has constant rows and statements as Realms and its members grow',
  async () => {
    const base = await partitionPosition();
    const fixture = makePopulation('realm-leave-neighbours', publicRealm, base);
    let actors: Candidate[] = [];
    const nativePlans = observeNativeGrowthPlans(db);
    const report = await checkGrowth(db, {
      name: 'Leave a Realm',
      rule: 'series',
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        actors = await growPopulation(
          fixture.population,
          scale,
          previous,
          () => fixture.candidates('member', memberScopes),
          memberScopes,
        );
      },
      async warmup(_database, scale, repetition) {
        await nativePlans.run({ check: 'Leave a Realm', scale, repetition, phase: 'warmup' }, () =>
          runLeave(actors[repetition]!),
        );
      },
      async operation(_database, scale, repetition) {
        await nativePlans.run({ check: 'Leave a Realm', scale, repetition, phase: 'measured' }, () =>
          runLeave(actors[repetition]!),
        );
      },
    }).finally(() => nativePlans.flush());
    await assertCommunityPlans(report);
    showSamples('Leave a Realm', report);

    async function runLeave(actor: Candidate): Promise<void> {
      const result = await call('DELETE', `/v1/realms/${publicRealm.realmId}/membership`, { bearer: actor.bearer });
      expect(result.response.status, JSON.stringify(result.value)).toBe(202);
      const workflowId = String(result.value.workflowId);
      expect(workflowId).toMatch(/^community\.leave:[0-9a-f]{32}$/);
      await complete(workflowId);
      await verifyMembership(publicRealm.realmId, actor.accountId, false);
      await verifyFollow(actor.accountId, publicRealm.spaceId);
    }
  },
  600_000,
);

test.serial(
  'Add a Realm member has constant rows and statements as Realms and its members grow',
  async () => {
    const base = await partitionPosition();
    const fixture = makePopulation('realm-add-neighbours', protectedRealm, base);
    let actors: Candidate[] = [];
    const report = await checkGrowth(db, {
      name: 'Add a Realm member',
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        actors = await growPopulation(
          fixture.population,
          scale,
          previous,
          () => fixture.candidates('new', ['realm:join', 'realm:read']),
          managerScopes,
        );
      },
      async warmup(_database, _scale, repetition) {
        await runAdd(actors[repetition]!);
      },
      async operation(_database, _scale, repetition) {
        await runAdd(actors[repetition]!);
      },
    });
    await assertCommunityPlans(report);
    showSamples('Add a Realm member', report);

    async function runAdd(actor: Candidate): Promise<void> {
      const result = await call('POST', `/v1/realms/${protectedRealm.realmId}/members`, {
        bearer: ownerBearer,
        key: crypto.randomUUID(),
        body: { accountId: actor.accountId },
      });
      expect(result.response.status, JSON.stringify(result.value)).toBe(202);
      const workflowId = String(result.value.workflowId);
      expect(workflowId).toMatch(/^community\.join:[0-9a-f]{32}$/);
      await complete(workflowId);
      await verifyMembership(protectedRealm.realmId, actor.accountId, true);
      await verifyFollow(actor.accountId, protectedRealm.spaceId);
    }
  },
  600_000,
);
