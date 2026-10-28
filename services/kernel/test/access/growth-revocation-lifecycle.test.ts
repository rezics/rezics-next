import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createLifecycleInternals, type HandleTransition } from '../../src/access/lifecycle.ts';
import { createSessionRevocationCommands } from '../../src/access/session-revocation.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { GrowthBoundError } from '../support/growth-bound.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const SCALES = [4, 16, 64] as const;
const ROWS_PER_SCALE = 500;
const HOT_ACCOUNT_ROUTE = 0x31a0;
const OTHER_ACCOUNT_ROUTE = 0x68b0;
const HOT_HANDLE_ROUTE = 0x2345;
const OTHER_HANDLE_ROUTE = 0x6789;
const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
const PLATFORM_GOVERNANCE_ROLE = 'platform.governance';
const AUTH_CLIENT = 'growth-revocation-client';
const GLOBAL_ID = PLATFORM_RESOURCE.id;
const GROWTH_ACCESS_ACTIONS = new Map([['account:suspend', { anonymous: false }]]);
const HANDLE_CLAIM_COUNT = 128;
const RUNS_PER_SCALE = 4;

let db: GrowthDatabase;
let authPool: Pool;
let authService: Awaited<ReturnType<typeof createAuthService>>;
let access: ReturnType<typeof admittedAccess>;
let revocation: ReturnType<typeof createSessionRevocationCommands>;
let governorId: string;

function hashRoute(handle: string): number {
  return createHash('sha256').update(handle).digest().readUInt16BE(0);
}

function handlesForRoute(route: number, count: number, prefix: string): string[] {
  const result: string[] = [];
  for (let candidate = 0; result.length < count; candidate++) {
    const handle = `${prefix}${candidate.toString(36)}`;
    if (hashRoute(handle) === route) result.push(handle);
  }
  return result;
}

function partition(route: number): number {
  return partitionOf(route)!;
}

type AccountFixture = {
  readonly accountId: string;
  readonly state?: 'active' | 'pending' | 'deleted';
  readonly handle?: string | null;
  readonly registrationId?: string | null;
  readonly registrationExpiresAt?: string | null;
  readonly fenced?: boolean;
  readonly handleOperationId?: string | null;
};

async function insertAccounts(database: GrowthDatabase, rows: readonly AccountFixture[]): Promise<void> {
  if (rows.length === 0) return;
  const routes = rows.map(({ accountId }) => routeOf(accountId)!);
  const accountIds = rows.map(({ accountId }) => accountId);
  const states = rows.map(({ state }) => state ?? 'active');
  const handles = rows.map(({ handle }) => handle ?? '');
  const registrations = rows.map(({ registrationId }) => registrationId ?? '');
  const expirations = rows.map(({ registrationExpiresAt }) => registrationExpiresAt ?? '');
  const fences = rows.map(({ fenced }) => fenced ?? false);
  const operations = rows.map(({ handleOperationId }) => handleOperationId ?? '');
  await database.admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, handle, registration_id, registration_expires_at,
        authn_fenced, handle_operation_id, transaction_id)
     SELECT route, account_id, 'actor', state, NULLIF(handle, ''), NULLIF(registration_id, '')::uuid,
            NULLIF(registration_expires_at, '')::timestamptz, authn_fenced,
            NULLIF(handle_operation_id, ''), account_id
     FROM unnest($1::integer[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
                 $7::boolean[], $8::text[])
       AS rows(route, account_id, state, handle, registration_id, registration_expires_at,
               authn_fenced, handle_operation_id)`,
    [routes, accountIds, states, handles, registrations, expirations, fences, operations],
  );
}

type ClaimFixture = {
  readonly handle: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly state: 'pending' | 'active' | 'reserved';
  readonly expiresAt?: string | null;
  readonly reservedUntil?: string | null;
  readonly holdOperationId?: string | null;
  readonly holdExpectedHandle?: string | null;
};

async function insertHandleClaims(database: GrowthDatabase, rows: readonly ClaimFixture[]): Promise<void> {
  if (rows.length === 0) return;
  const routes = rows.map(({ handle }) => hashRoute(handle));
  const handles = rows.map(({ handle }) => handle);
  const accountIds = rows.map(({ accountId }) => accountId);
  const states = rows.map(({ state }) => state);
  const expirations = rows.map(({ expiresAt }) => expiresAt ?? '');
  const reservations = rows.map(({ reservationId }) => reservationId);
  const reservedUntil = rows.map(({ reservedUntil: value }) => value ?? '');
  const operations = rows.map(({ holdOperationId }) => holdOperationId ?? '');
  const expected = rows.map(({ holdExpectedHandle }) => holdExpectedHandle ?? '');
  await database.admin.query(
    `INSERT INTO access.handle_claim
       (route, normalized_handle, account_id, state, expires_at, reserved_until, transaction_id,
        reservation_id, hold_operation_id, hold_expected_handle)
     SELECT route, handle, account_id, state, NULLIF(expires_at, '')::timestamptz,
            NULLIF(reserved_until, '')::timestamptz, account_id, reservation_id,
            NULLIF(hold_operation_id, ''), NULLIF(hold_expected_handle, '')
     FROM unnest($1::integer[], $2::text[], $3::uuid[], $4::text[], $5::text[], $6::uuid[],
                 $7::text[], $8::text[], $9::text[])
       AS rows(route, handle, account_id, state, expires_at, reservation_id, reserved_until,
               hold_operation_id, hold_expected_handle)`,
    [routes, handles, accountIds, states, expirations, reservations, reservedUntil, operations, expected],
  );
}

async function insertReceiptHistory(
  database: GrowthDatabase,
  rows: readonly {
    readonly route: number;
    readonly principalId: string;
    readonly kind: string;
    readonly key: string;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  const partitions = rows.map(({ route }) => partition(route));
  const principals = rows.map(({ principalId }) => principalId);
  const kinds = rows.map(({ kind }) => kind);
  const keys = rows.map(({ key }) => key);
  const transactions = rows.map(({ route }) => newId(route));
  await database.admin.query(
    `INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key,
        request_digest, epoch, position, transaction_id, response)
     SELECT partition_no, 'account', principal_id, command_kind, idempotency_key,
            decode(repeat('00', 32), 'hex'), 1, 1, transaction_id, '{}'::jsonb
     FROM unnest($1::integer[], $2::uuid[], $3::text[], $4::text[], $5::uuid[])
       AS rows(partition_no, principal_id, command_kind, idempotency_key, transaction_id)`,
    [partitions, principals, kinds, keys, transactions],
  );
}

async function insertAuthUsers(database: GrowthDatabase, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await database.admin.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     SELECT id, '', NULL, false FROM unnest($1::text[]) AS rows(id)`,
    [ids],
  );
}

async function insertAuthSessions(
  database: GrowthDatabase,
  rows: readonly { readonly ownerId: string; readonly sessionId: string; readonly token: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await database.admin.query(
    `INSERT INTO session
       (id, "expiresAt", token, "updatedAt", "userId", "clientId", "grantedScope",
        "authnEpoch", "authTime", "authMethods")
     SELECT id, statement_timestamp() + interval '1 year', token, statement_timestamp(), owner_id,
            $4, 'account:suspend', 1, 1, 'pwd'
     FROM unnest($1::text[], $2::text[], $3::text[]) AS rows(id, token, owner_id)`,
    [
      rows.map(({ sessionId }) => sessionId),
      rows.map(({ token }) => token),
      rows.map(({ ownerId }) => ownerId),
      AUTH_CLIENT,
    ],
  );
}

function sessionRows(accountId: string, count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    ownerId: accountId,
    sessionId: `${prefix}-session-${index}`,
    token: `${prefix}-token-${index}`,
  }));
}

async function seedSessionHistory(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const historyRows = ROWS_PER_SCALE * (scale - previous);
  const hotIds = Array.from({ length: Math.ceil(historyRows / 2) }, () => newId(HOT_ACCOUNT_ROUTE));
  const otherIds = Array.from({ length: Math.floor(historyRows / 2) }, () => newId(OTHER_ACCOUNT_ROUTE));
  const historyIds = [...hotIds, ...otherIds];
  await insertAccounts(
    database,
    historyIds.map((accountId) => ({ accountId })),
  );
  await insertAuthUsers(database, historyIds);
  await insertAuthSessions(
    database,
    historyIds.map((ownerId, index) => ({
      ownerId,
      sessionId: `history-session-${ownerId}`,
      token: `history-token-${ownerId}`,
    })),
  );

  const grantIds = [...hotIds, ...otherIds];
  const grantTransactions = grantIds.map((id) => newId(routeOf(id)!));
  await database.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     SELECT 0, $1::uuid, 'identity', subject_id, '', $2, '(,)'::tstzrange, transaction_id
     FROM unnest($3::uuid[], $4::uuid[]) AS rows(subject_id, transaction_id)`,
    [GLOBAL_ID, PLATFORM_GOVERNANCE_ROLE, grantIds, grantTransactions],
  );
  await database.admin.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
     SELECT 0, $1::uuid, subject_id, '', 'account:suspend', '(,)'::tstzrange, transaction_id
     FROM unnest($2::uuid[], $3::uuid[]) AS rows(subject_id, transaction_id)`,
    [GLOBAL_ID, grantIds, grantTransactions],
  );
  await database.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     SELECT 0, $1::uuid, subject_id, '', 'account:suspend', 'resource', '(,)'::tstzrange, transaction_id
     FROM unnest($2::uuid[], $3::uuid[]) AS rows(subject_id, transaction_id)`,
    [GLOBAL_ID, grantIds, grantTransactions],
  );

  const receipts = historyIds.map((principalId, index) => ({
    route: index < hotIds.length ? HOT_ACCOUNT_ROUTE : OTHER_ACCOUNT_ROUTE,
    principalId: governorId,
    kind: 'access.account.revoke-sessions',
    key: `history-revocation-${principalId}`,
  }));
  await insertReceiptHistory(database, receipts);

  const targets = Array.from({ length: RUNS_PER_SCALE }, () => newId(HOT_ACCOUNT_ROUTE));
  await insertAccounts(
    database,
    targets.map((accountId) => ({ accountId })),
  );
  await insertAuthUsers(database, targets);
  await insertAuthSessions(
    database,
    targets.flatMap((accountId, index) => sessionRows(accountId, 3, `target-${scale}-${index}-${accountId}`)),
  );
  for (const [offset, accountId] of targets.entries()) targetAccounts.set(nextSessionRepetition + offset, accountId);
  nextSessionRepetition += RUNS_PER_SCALE;
}

let nextSessionRepetition = 0;
const targetAccounts = new Map<number, string>();

async function seedSessionTarget(database: GrowthDatabase, prefix: string): Promise<string> {
  const accountId = newId(HOT_ACCOUNT_ROUTE);
  await insertAccounts(database, [{ accountId }]);
  await insertAuthUsers(database, [accountId]);
  await insertAuthSessions(database, sessionRows(accountId, 3, `${prefix}-${accountId}`));
  return accountId;
}

function sessionContext() {
  return { pool: db.pool, deadline: Date.now() + 30_000 };
}

async function revokeOne(accountId: string): Promise<void> {
  const actor = await authenticateAccount(access, sessionContext(), {
    accountId: governorId,
    clientId: AUTH_CLIENT,
    scopes: ['account:suspend'],
    authnEpoch: 1,
  });
  await revocation.revoke(
    { actor, pool: db.pool, deadline: Date.now() + 30_000 },
    { accountId, key: `growth-revoke-${accountId}` },
  );
  await authService.internal.revokeSessions(accountId);
}

async function reportExpectedGrowthFailure(
  name: string,
  run: () => Promise<unknown>,
  diagnose: () => Promise<() => Promise<unknown>>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof GrowthBoundError)) {
      console.error(`${name} failed outside its growth bound`, error);
      return;
    }
    const operation = await diagnose();
    const captured = await capture(db, operation);
    console.error(
      JSON.stringify(
        {
          check: name,
          series: error.samples,
          sql: captured.capture.statements,
          plans: captured.capture.plans,
        },
        null,
        2,
      ),
    );
    throw error;
  }
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  migrateAuth(db.url);
  authPool = db.openPool();
  const signingPair = await generateKeyPair('ES256', { extractable: true });
  const signing = { ...(await exportJWK(signingPair.privateKey)), kid: 'growth-revocation', alg: 'ES256' };
  const stub = trustedAccessPorts({
    async readAccount() {
      return null;
    },
    async authorizeProvisioning() {
      throw new Error('Provisioning is outside this growth path');
    },
  });
  authService = await createAuthService({
    database: authPool,
    issuer: 'https://growth-revocation.auth.test',
    audience: 'https://growth-revocation.api.test',
    secret: 'growth-revocation-secret-is-long-enough',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: stub,
  });
  await db.admin.query('INSERT INTO auth_client (client_id, first_party, scopes) VALUES ($1, true, $2::text[])', [
    AUTH_CLIENT,
    ['account:suspend'],
  ]);
  access = admittedAccess({ actions: GROWTH_ACCESS_ACTIONS });
  revocation = createSessionRevocationCommands({ pool: db.pool, access, clock: () => new Date() });
  governorId = newId(HOT_ACCOUNT_ROUTE);
  await insertAccounts(db, [{ accountId: governorId }]);
  await bootstrapGovernance(db.pool, governorId);
  await insertAuthUsers(db, [governorId]);
  await insertAuthSessions(db, sessionRows(governorId, 2, 'fixed-governor'));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

test('Session revocation stays within its bound as receipts, accounts and session history grow', async () => {
  const run = async () => {
    const report = await checkGrowth(db, {
      name: 'session revocation command and native Auth deletion',
      scales: SCALES,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 3,
      warmups: 1,
      async grow(database, scale, previous) {
        await seedSessionHistory(database, scale, previous);
      },
      operation: async (_database, _scale, repetition) => revokeOne(targetAccounts.get(repetition)!),
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
  };
  await reportExpectedGrowthFailure('session revocation command and native Auth deletion', run, async () => {
    const accountId = await seedSessionTarget(db, 'diagnostic-session-revocation');
    return () => revokeOne(accountId);
  });
}, 300_000);

function lifecycleKinds() {
  return [
    'access.handle-held',
    'access.transition-handle-claimed',
    'access.transition-handle-redirected',
    'access.handle-transition-completed',
    'access.handle-transition-cancelled',
    'access.handle-transition-released',
  ];
}

type TransitionRows = {
  readonly operations: {
    readonly route: number;
    readonly accountId: string;
    readonly operationId: string;
    readonly handle: string;
    readonly reservationId: string;
    readonly expectedHandle: string | null;
    readonly oldReservationId: string | null;
    readonly state: 'published' | 'cancelled';
  }[];
  readonly effects: {
    readonly route: number;
    readonly handle: string;
    readonly accountId: string;
    readonly reservationId: string;
    readonly operationId: string;
    readonly effect: 'active' | 'reserved';
  }[];
  readonly expiries: {
    readonly route: number;
    readonly accountId: string;
    readonly reservationId: string;
    readonly handle: string;
  }[];
};

async function insertTransitionHistory(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const hotAccounts = Array.from({ length: Math.ceil(count / 2) }, () => newId(HOT_ACCOUNT_ROUTE));
  const otherAccounts = Array.from({ length: Math.floor(count / 2) }, () => newId(OTHER_ACCOUNT_ROUTE));
  const accounts = [...hotAccounts, ...otherAccounts];
  await insertAccounts(
    database,
    accounts.map((accountId) => ({ accountId })),
  );

  const operations = accounts.map((accountId, index) => ({
    route: routeOf(accountId)!,
    accountId,
    operationId: `history-operation-${accountId}`,
    handle: `history_${accountId.replaceAll('-', '')}`,
    reservationId: newId(routeOf(accountId)!),
    expectedHandle: null,
    oldReservationId: null,
    state: 'published' as const,
  }));
  await database.admin.query(
    `INSERT INTO access.lifecycle_handle_operation
       (route, account_id, operation_id, handle, reservation_id, expected_handle,
        old_reservation_id, state, transaction_id)
     SELECT route, account_id, operation_id, handle, reservation_id, NULLIF(expected_handle, ''),
            NULLIF(old_reservation_id, '')::uuid, state, transaction_id
     FROM unnest($1::integer[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[],
                 $7::text[], $8::text[], $9::uuid[])
       AS rows(route, account_id, operation_id, handle, reservation_id, expected_handle,
               old_reservation_id, state, transaction_id)`,
    [
      operations.map(({ route }) => route),
      operations.map(({ accountId }) => accountId),
      operations.map(({ operationId }) => operationId),
      operations.map(({ handle }) => handle),
      operations.map(({ reservationId }) => reservationId),
      operations.map(({ expectedHandle }) => expectedHandle ?? ''),
      operations.map(({ oldReservationId }) => oldReservationId ?? ''),
      operations.map(({ state }) => state),
      operations.map(({ route }) => newId(route)),
    ],
  );

  const effectRows = accounts.map((accountId, index) => {
    const handle = `history_effect_${accountId.replaceAll('-', '')}`;
    return {
      route: hashRoute(handle),
      handle,
      accountId,
      reservationId: newId(routeOf(accountId)!),
      operationId: `history-effect-${accountId}`,
      effect: index % 2 === 0 ? ('active' as const) : ('reserved' as const),
    };
  });
  await database.admin.query(
    `INSERT INTO access.lifecycle_handle_effect
       (route, normalized_handle, account_id, reservation_id, operation_id, effect, transaction_id)
     SELECT route, handle, account_id, reservation_id, operation_id, effect, transaction_id
     FROM unnest($1::integer[], $2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::uuid[])
       AS rows(route, handle, account_id, reservation_id, operation_id, effect, transaction_id)`,
    [
      effectRows.map(({ route }) => route),
      effectRows.map(({ handle }) => handle),
      effectRows.map(({ accountId }) => accountId),
      effectRows.map(({ reservationId }) => reservationId),
      effectRows.map(({ operationId }) => operationId),
      effectRows.map(({ effect }) => effect),
      effectRows.map(({ accountId }) => newId(routeOf(accountId)!)),
    ],
  );

  const expiryRows = accounts.map((accountId) => ({
    route: routeOf(accountId)!,
    accountId,
    reservationId: newId(routeOf(accountId)!),
    handle: `history_expiry_${accountId.replaceAll('-', '')}`,
  }));
  await database.admin.query(
    `INSERT INTO access.lifecycle_registration_expiry
       (route, account_id, reservation_id, handle, transaction_id)
     SELECT route, account_id, reservation_id, handle, transaction_id
     FROM unnest($1::integer[], $2::uuid[], $3::uuid[], $4::text[], $5::uuid[])
       AS rows(route, account_id, reservation_id, handle, transaction_id)`,
    [
      expiryRows.map(({ route }) => route),
      expiryRows.map(({ accountId }) => accountId),
      expiryRows.map(({ reservationId }) => reservationId),
      expiryRows.map(({ handle }) => handle),
      expiryRows.map(({ route }) => newId(route)),
    ],
  );

  const receipts = lifecycleKinds().flatMap((kind) =>
    accounts.map((principalId, index) => {
      const accountRoute = index < hotAccounts.length ? HOT_ACCOUNT_ROUTE : OTHER_ACCOUNT_ROUTE;
      const handleRoute = index < hotAccounts.length ? HOT_HANDLE_ROUTE : OTHER_HANDLE_ROUTE;
      return {
        route:
          kind === 'access.handle-transition-completed' || kind === 'access.handle-transition-cancelled'
            ? accountRoute
            : handleRoute,
        principalId: SERVICE_ID,
        kind,
        key: `history:${kind}:${principalId}`,
      };
    }),
  );
  await insertReceiptHistory(database, receipts);

  const unrelatedHandles = Array.from({ length: count }, (_, index) => `history_claim_${scale}_${previous}_${index}`);
  const unrelatedClaims = unrelatedHandles.map((handle, index) => ({
    handle,
    accountId: accounts[index]!,
    reservationId: newId(routeOf(accounts[index]!)!),
    state: 'active' as const,
  }));
  await insertHandleClaims(database, unrelatedClaims);
}

type TransitionInput = HandleTransition & { readonly currentHandle: string | null };
type TransitionRun = {
  readonly hold: TransitionInput;
  readonly finalize: TransitionInput;
  readonly redirect: TransitionInput;
  readonly complete: TransitionInput;
  readonly cancel: TransitionInput;
  readonly release: TransitionInput;
};

let transitionRepetition = 0;
const transitionRuns = new Map<number, TransitionRun>();
let availableHandles: string[] = [];
let unrelatedHotHandles: string[] = [];
let unrelatedOtherHandles: string[] = [];
let nextHandle = 0;

function freshHandle(): string {
  const handle = availableHandles[nextHandle++];
  if (!handle) throw new Error('Growth fixture handle pool was exhausted');
  return handle;
}

function transitionInput(accountId: string, handle: string, currentHandle: string | null): TransitionInput {
  return {
    accountId,
    key: `growth-${Bun.randomUUIDv7()}`,
    handle,
    reservationId: newId(HOT_ACCOUNT_ROUTE),
    operationId: `growth-op-${Bun.randomUUIDv7()}`,
    expectedHandle: currentHandle,
    currentHandle,
  };
}

function opRow(input: TransitionInput, state: 'published' | 'cancelled', oldReservationId: string | null = null) {
  return {
    route: routeOf(input.accountId)!,
    accountId: input.accountId,
    operationId: input.operationId,
    handle: input.handle,
    reservationId: input.reservationId,
    expectedHandle: input.expectedHandle,
    oldReservationId,
    state,
  };
}

async function seedTransitionRun(database: GrowthDatabase): Promise<TransitionRun> {
  const holdAccount = newId(HOT_ACCOUNT_ROUTE);
  const finalizeAccount = newId(HOT_ACCOUNT_ROUTE);
  const redirectAccount = newId(HOT_ACCOUNT_ROUTE);
  const completeAccount = newId(HOT_ACCOUNT_ROUTE);
  const cancelAccount = newId(HOT_ACCOUNT_ROUTE);
  const releaseAccount = newId(HOT_ACCOUNT_ROUTE);
  const hold = transitionInput(holdAccount, freshHandle(), null);
  const finalize = transitionInput(finalizeAccount, freshHandle(), null);
  const redirectOld = freshHandle();
  const redirect = transitionInput(redirectAccount, freshHandle(), redirectOld);
  const completeOld = freshHandle();
  const complete = transitionInput(completeAccount, freshHandle(), completeOld);
  const cancel = transitionInput(cancelAccount, freshHandle(), 'current_handle');
  const release = transitionInput(releaseAccount, freshHandle(), 'current_handle');
  const rows: TransitionRows['operations'] = [
    opRow(finalize, 'published'),
    opRow(redirect, 'published', newId(HOT_ACCOUNT_ROUTE)),
    opRow(complete, 'published', newId(HOT_ACCOUNT_ROUTE)),
    opRow(release, 'cancelled'),
  ];
  const accounts: AccountFixture[] = [
    { accountId: hold.accountId },
    { accountId: finalize.accountId, handle: finalize.handle, handleOperationId: finalize.operationId },
    { accountId: redirect.accountId, handle: redirect.handle, handleOperationId: redirect.operationId },
    { accountId: complete.accountId, handle: complete.handle, handleOperationId: complete.operationId },
    { accountId: cancel.accountId, handle: cancel.currentHandle },
    { accountId: release.accountId, handle: release.currentHandle },
  ];
  await insertAccounts(database, accounts);

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const heldClaims: ClaimFixture[] = [
    {
      handle: hold.handle,
      accountId: hold.accountId,
      reservationId: hold.reservationId,
      state: 'pending',
      expiresAt: future,
    },
    {
      handle: finalize.handle,
      accountId: finalize.accountId,
      reservationId: finalize.reservationId,
      state: 'pending',
      expiresAt: future,
      holdOperationId: finalize.operationId,
    },
    {
      handle: redirect.handle,
      accountId: redirect.accountId,
      reservationId: redirect.reservationId,
      state: 'active',
    },
    {
      handle: redirectOld,
      accountId: redirect.accountId,
      reservationId: rows[1]!.oldReservationId!,
      state: 'active',
    },
    {
      handle: complete.handle,
      accountId: complete.accountId,
      reservationId: complete.reservationId,
      state: 'active',
    },
    {
      handle: completeOld,
      accountId: complete.accountId,
      reservationId: rows[2]!.oldReservationId!,
      state: 'reserved',
      reservedUntil: future,
    },
    {
      handle: cancel.handle,
      accountId: cancel.accountId,
      reservationId: cancel.reservationId,
      state: 'pending',
      expiresAt: future,
      holdOperationId: cancel.operationId,
    },
    {
      handle: release.handle,
      accountId: release.accountId,
      reservationId: release.reservationId,
      state: 'pending',
      expiresAt: future,
      holdOperationId: release.operationId,
    },
  ];
  await insertHandleClaims(database, heldClaims);

  await database.admin.query(
    `INSERT INTO access.lifecycle_handle_operation
       (route, account_id, operation_id, handle, reservation_id, expected_handle,
        old_reservation_id, state, transaction_id)
     SELECT route, account_id, operation_id, handle, reservation_id, NULLIF(expected_handle, ''),
            NULLIF(old_reservation_id, '')::uuid, state, transaction_id
     FROM unnest($1::integer[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[],
                 $7::text[], $8::text[], $9::uuid[])
       AS rows(route, account_id, operation_id, handle, reservation_id, expected_handle,
               old_reservation_id, state, transaction_id)`,
    [
      rows.map(({ route }) => route),
      rows.map(({ accountId }) => accountId),
      rows.map(({ operationId }) => operationId),
      rows.map(({ handle }) => handle),
      rows.map(({ reservationId }) => reservationId),
      rows.map(({ expectedHandle }) => expectedHandle ?? ''),
      rows.map(({ oldReservationId }) => oldReservationId ?? ''),
      rows.map(({ state }) => state),
      rows.map(({ route }) => newId(route)),
    ],
  );

  const effectRows: TransitionRows['effects'] = [
    {
      route: HOT_HANDLE_ROUTE,
      handle: complete.handle,
      accountId: complete.accountId,
      reservationId: complete.reservationId,
      operationId: complete.operationId,
      effect: 'active',
    },
    {
      route: HOT_HANDLE_ROUTE,
      handle: completeOld,
      accountId: complete.accountId,
      reservationId: rows[2]!.oldReservationId!,
      operationId: complete.operationId,
      effect: 'reserved',
    },
  ];
  await database.admin.query(
    `INSERT INTO access.lifecycle_handle_effect
       (route, normalized_handle, account_id, reservation_id, operation_id, effect, transaction_id)
     SELECT route, handle, account_id, reservation_id, operation_id, effect, transaction_id
     FROM unnest($1::integer[], $2::text[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::uuid[])
       AS rows(route, handle, account_id, reservation_id, operation_id, effect, transaction_id)`,
    [
      effectRows.map(({ route }) => route),
      effectRows.map(({ handle }) => handle),
      effectRows.map(({ accountId }) => accountId),
      effectRows.map(({ reservationId }) => reservationId),
      effectRows.map(({ operationId }) => operationId),
      effectRows.map(({ effect }) => effect),
      effectRows.map(({ accountId }) => newId(routeOf(accountId)!)),
    ],
  );
  return { hold, finalize, redirect, complete, cancel, release };
}

async function growTransitions(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await insertTransitionHistory(database, scale, previous);
  const handles = Array.from({ length: RUNS_PER_SCALE }, () => seedTransitionRun(database));
  for (const [offset, promise] of handles.entries()) transitionRuns.set(transitionRepetition + offset, await promise);
  transitionRepetition += RUNS_PER_SCALE;
}

let expiryRepetition = 0;
const expiryRuns = new Map<number, HandleTransition>();

async function insertExpiryHistory(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const count = ROWS_PER_SCALE * (scale - previous);
  const hotAccounts = Array.from({ length: Math.ceil(count / 2) }, () => newId(HOT_ACCOUNT_ROUTE));
  const otherAccounts = Array.from({ length: Math.floor(count / 2) }, () => newId(OTHER_ACCOUNT_ROUTE));
  const accounts = [...hotAccounts, ...otherAccounts];
  await insertAccounts(
    database,
    accounts.map((accountId) => ({ accountId, state: 'deleted', fenced: true })),
  );
  await insertHandleClaims(
    database,
    accounts.map((accountId, index) => ({
      handle:
        previous === 0 && index < unrelatedHotHandles.length
          ? unrelatedHotHandles[index]!
          : previous === 0 && index < unrelatedHotHandles.length + unrelatedOtherHandles.length
            ? unrelatedOtherHandles[index - unrelatedHotHandles.length]!
            : `expiry_claim_${scale}_${previous}_${index}`,
      accountId,
      reservationId: newId(routeOf(accountId)!),
      state: 'active' as const,
    })),
  );
  const expiryRows = accounts.map((accountId) => ({
    route: routeOf(accountId)!,
    accountId,
    reservationId: newId(routeOf(accountId)!),
    handle: `expiry_history_${accountId.replaceAll('-', '')}`,
  }));
  await database.admin.query(
    `INSERT INTO access.lifecycle_registration_expiry
       (route, account_id, reservation_id, handle, transaction_id)
     SELECT route, account_id, reservation_id, handle, transaction_id
     FROM unnest($1::integer[], $2::uuid[], $3::uuid[], $4::text[], $5::uuid[])
       AS rows(route, account_id, reservation_id, handle, transaction_id)`,
    [
      expiryRows.map(({ route }) => route),
      expiryRows.map(({ accountId }) => accountId),
      expiryRows.map(({ reservationId }) => reservationId),
      expiryRows.map(({ handle }) => handle),
      expiryRows.map(({ route }) => newId(route)),
    ],
  );

  const historyReceipts = accounts.map((principalId, index) => ({
    route: index < hotAccounts.length ? HOT_HANDLE_ROUTE : OTHER_HANDLE_ROUTE,
    principalId: SERVICE_ID,
    kind: 'access.registration-handle-released',
    key: `history:expired-registration:${principalId}`,
  }));
  await insertReceiptHistory(database, historyReceipts);

  const targets: HandleTransition[] = [];
  for (let index = 0; index < RUNS_PER_SCALE; index++) {
    targets.push(await seedExpiredTarget(database, `expired-${scale}-${previous}-${index}`));
  }
  for (const [offset, input] of targets.entries()) expiryRuns.set(expiryRepetition + offset, input);
  expiryRepetition += RUNS_PER_SCALE;
}

async function releaseExpired(input: HandleTransition): Promise<unknown> {
  return lifecycle.releaseExpiredRegistrationHandle({
    accountId: input.accountId,
    key: input.key,
    handle: input.handle,
    reservationId: input.reservationId,
  });
}

async function seedExpiredTarget(database: GrowthDatabase, prefix: string): Promise<HandleTransition> {
  const accountId = newId(HOT_ACCOUNT_ROUTE);
  const handle = freshHandle();
  const reservationId = newId(HOT_ACCOUNT_ROUTE);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const input: HandleTransition = {
    accountId,
    handle,
    reservationId,
    operationId: `${prefix}-operation-${Bun.randomUUIDv7()}`,
    expectedHandle: null,
    key: `${prefix}-key-${Bun.randomUUIDv7()}`,
  };
  await insertAccounts(database, [
    {
      accountId,
      state: 'deleted',
      handle,
      registrationId: reservationId,
      registrationExpiresAt: expiredAt,
      fenced: true,
    },
  ]);
  await insertHandleClaims(database, [{ handle, accountId, reservationId, state: 'pending', expiresAt: expiredAt }]);
  await database.admin.query(
    `INSERT INTO access.lifecycle_registration_expiry
       (route, account_id, reservation_id, handle, transaction_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [routeOf(accountId), accountId, reservationId, handle, newId(HOT_ACCOUNT_ROUTE)],
  );
  return input;
}

let lifecycle: ReturnType<typeof createLifecycleInternals>;

beforeAll(async () => {
  availableHandles = handlesForRoute(HOT_HANDLE_ROUTE, HANDLE_CLAIM_COUNT, 'growth_handle_');
  unrelatedHotHandles = handlesForRoute(HOT_HANDLE_ROUTE, 8, 'history_claim_hot_');
  unrelatedOtherHandles = handlesForRoute(OTHER_HANDLE_ROUTE, 8, 'history_claim_other_');
  lifecycle = createLifecycleInternals({
    pool: db.pool,
    routeKey: randomBytes(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
}, 120_000);

test('Handle transitions stay within their bound as transition, effect and expiry history grows', async () => {
  const run = async () =>
    await checkGrowth(db, {
      name: 'handle transition internal steps',
      scales: SCALES,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 3,
      warmups: 1,
      grow: growTransitions,
      async operation(_database, _scale, repetition) {
        const state = transitionRuns.get(repetition)!;
        await lifecycle.holdHandle(state.hold);
        await lifecycle.finalizeHandleTransition(state.finalize);
        await lifecycle.redirectTransitionHandle(state.redirect);
        await lifecycle.completeHandleTransition(state.complete);
        await lifecycle.cancelHandleTransition(state.cancel);
        await lifecycle.releaseHandleTransition(state.release);
      },
    });
  await reportExpectedGrowthFailure('handle transition internal steps', run, async () => {
    const input = await seedTransitionRun(db);
    return async () => {
      await lifecycle.holdHandle(input.hold);
      await lifecycle.finalizeHandleTransition(input.finalize);
      await lifecycle.redirectTransitionHandle(input.redirect);
      await lifecycle.completeHandleTransition(input.complete);
      await lifecycle.cancelHandleTransition(input.cancel);
      await lifecycle.releaseHandleTransition(input.release);
    };
  });
}, 300_000);

test('Expired registration release stays within its bound as expiry history grows', async () => {
  const run = async () =>
    await checkGrowth(db, {
      name: 'expired registration release',
      scales: SCALES,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 3,
      warmups: 1,
      grow: insertExpiryHistory,
      operation: async (_database, _scale, repetition) => {
        await releaseExpired(expiryRuns.get(repetition)!);
      },
    });
  await reportExpectedGrowthFailure('expired registration release', run, async () => {
    const input = await seedExpiredTarget(db, 'diagnostic-expired-registration');
    return () => releaseExpired(input);
  });
}, 300_000);
