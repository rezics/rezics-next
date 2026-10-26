import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createAccess } from '../../src/access/index.ts';
import { routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Row } from '../support/growth.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `growth_recovery_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

let db: GrowthDatabase;
let fixture: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let bindings: ReturnType<typeof createNativeAccountBindings>;
let accountId: string;
let authDatabase: Pool;
let fixturePool: Pool;
let token = '';
let delivered: (() => void) | undefined;
let serial = 0;
const issuer = 'https://growth-recovery.auth.test';
const password = 'native growth recovery password';
const repetitions = 3;
const growthTimeout = 120_000;
const history: Record<string, readonly Row[]> = {};
let pendingRecovery: Row;
let pendingAccount: Row;
const request = (path: string, body: unknown) =>
  service.handler(
    new Request(issuer + path, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
async function recover(subject = accountId, email = 'human@growth.test', snapshot?: () => Promise<void>) {
  // Prepare a fresh delivery without changing any authoritative recovery,
  // credential, barrier or completion history measured by this series.
  const mailKey = createHmac('sha256', 'native-growth-recovery-persistent-secret-32-bytes')
    .update(JSON.stringify(['auth-recovery-mail-v1', subject]))
    .digest('hex');
  await fixturePool.query('DELETE FROM auth_attempt_counter WHERE key=$1', [mailKey]);
  await bindings.internalLifecycle.raiseFence({ accountId: subject, key: `growth-fence-${serial++}` });
  const delivery = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  expect((await request('/recovery/start', { email })).status).toBe(200);
  await delivery;
  await snapshot?.();
  const body = { account_id: subject, token, new_password: password };
  expect((await request('/recovery/complete', body)).status).toBe(200);
  // Exact success replay includes real Auth/current-credential resolution and
  // native authorization before receipt disclosure in the same capture.
  expect((await request('/recovery/complete', body)).status).toBe(200);
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await cloneAuthDatabase();
  fixturePool = new Pool({ connectionString: fixture.url });
  const database = db.openPool();
  authDatabase = database;
  const system = db.openPool();
  database.options.connectionString = fixture.url;
  system.options.connectionString = fixture.url;
  // The growth harness also owns these pools. Host shutdown may close them first.
  for (const pool of [database, system]) {
    const end = pool.end.bind(pool);
    let ended: Promise<void> | undefined;
    pool.end = (() => (ended ??= end())) as typeof pool.end;
  }
  const actions = new Map(['account:manage', 'access:grant'].map((action) => [action, { anonymous: false }]));
  const access = createAccess({ actions });
  bindings = createNativeAccountBindings({
    pool: db.pool,
    access,
    actions,
    routeKey: new Uint8Array(32).fill(81),
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
    auth: () => service,
    proofs: {
      workflow: createNativeWorkflowProofPorts({ database }),
      provisioning: createProvisioningEvidenceVerifier({ database }),
      barriers: createBarrierProofVerifier({ database }),
    },
  });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'growth-recovery',
  };
  host = await createAuthHost({
    database,
    systemDatabasePool: system,
    issuer,
    audience: 'https://growth.api.test',
    secret: 'native-growth-recovery-persistent-secret-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    stagingKey: new Uint8Array(32).fill(83),
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    recoveryDelivery: {
      async deliver(value) {
        token = value.token;
        delivered?.();
      },
    },
    maintenanceSchedule: '0 0 1 1 *',
  });
  service = host.service;
  await host.start();
  accountId = (
    await host.workflows.register({
      key: 'growth_recovery_human',
      handle: 'growth_recovery_human',
      email: 'human@growth.test',
      password,
    })
  ).accountId;
  await service.internal.registerClient({ clientId: 'growth-recovery', firstParty: true, scopes: ['account:manage'] });
  expect(
    (
      await request('/signin', {
        email: 'human@growth.test',
        password,
        client_id: 'growth-recovery',
        scope: ['account:manage'],
      })
    ).status,
  ).toBe(200);
  const sessions = (await fixturePool.query('SELECT * FROM session')).rows;
  expect(sessions.length).toBeGreaterThan(0);
  // Read the native rows once, including the verification before completion consumes it.
  // History copies are cardinality fixtures, never evidence presented to the product.
  await recover(accountId, 'human@growth.test', async () => {
    history['public.verification'] = (await fixturePool.query('SELECT * FROM verification')).rows;
    pendingRecovery = (await fixturePool.query('SELECT * FROM auth_recovery')).rows[0];
    pendingAccount = (await db.admin.query('SELECT * FROM access.account WHERE account_id=$1', [accountId])).rows[0];
  });
  for (const table of [
    'user',
    'account',
    'auth_recovery',
    'auth_barrier_proof',
    'auth_effect_receipt',
    'auth_recovery_establishment',
    'auth_attempt_counter',
  ]) {
    const predicate = table === 'auth_effect_receipt' ? " WHERE purpose='recovery'" : '';
    history[`public.${table}`] = (await fixturePool.query(`SELECT * FROM "${table}"${predicate}`)).rows;
    expect(history[`public.${table}`]!.length).toBeGreaterThan(0);
  }
  history['public.session'] = sessions;
  for (const table of ['access.account', 'access.lifecycle_fence_receipt', 'core.receipt']) {
    const predicate = table === 'core.receipt' ? " WHERE command_kind LIKE 'access.authentication-%'" : '';
    history[table] = (await db.admin.query(`SELECT * FROM ${table}${predicate}`)).rows.map(
      ({ actor_account_id: _generated, ...row }) => row,
    );
    expect(history[table]!.length).toBeGreaterThan(0);
  }
  // Recovery reads the coordination absence too. Get its otherwise-empty row
  // shape from one native reservation, then retain copies only on unrelated owners.
  const hold = await bindings.internalLifecycle.reserveCoordination({
    accountId,
    relatedAccountId: historyId(30_000, routeOf(accountId)!, accountId),
    purpose: 'operator',
    key: 'growth-coordination-prototype',
  });
  history['access.lifecycle_coordination'] = (
    await db.admin.query('SELECT * FROM access.lifecycle_coordination WHERE account_id=$1', [accountId])
  ).rows;
  expect(history['access.lifecycle_coordination']!.length).toBeGreaterThan(0);
  await db.admin.query('DELETE FROM access.lifecycle_coordination WHERE account_id=$1 AND reservation_id=$2', [
    accountId,
    hold.value.reservationId,
  ]);
}, 600000);
afterAll(async () => {
  await host?.stop();
  await db?.close();
  await fixturePool?.end();
  await fixture?.close();
});

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function historyId(ordinal: number, route: number, source: string): string {
  const hex = digest(`${ordinal}:${source}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8000-8000-${route.toString(16).padStart(4, '0')}${hex.slice(12, 20)}`;
}
function historyRows(ordinal: number, route: number, sameOwner: boolean): Record<string, readonly Row[]> {
  const owner = sameOwner ? accountId : historyId(ordinal, route, accountId);
  const replacements = new Map<string, string>();
  for (const rows of Object.values(history))
    for (const row of rows)
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'string' || !value || value === accountId) continue;
        if (
          [
            'id',
            'reference',
            'proof_hash',
            'operation_key',
            'consumed_operation',
            'consumed_verification_id',
            'receipt_id',
            'reservation_id',
            'establishment_id',
            'transaction_id',
            'idempotency_key',
            'key',
            'token',
            'identifier',
          ].includes(column)
        ) {
          replacements.set(
            value,
            /^[0-9a-f]{64}$/.test(value)
              ? digest(`${ordinal}:${value}`)
              : /^[0-9a-f-]{36}$/.test(value)
                ? historyId(ordinal, route, value)
                : `history-${ordinal}-${value}`,
          );
        }
      }
  const credential = history['public.account']![0]!.id as string;
  if (sameOwner) replacements.delete(credential);
  replacements.set(accountId, owner);
  replacements.set('human@growth.test', `history-${ordinal}@growth.test`);
  replacements.set('growth_recovery_human', `history-${ordinal}`);
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      for (const [source, target] of replacements) value = (value as string).replaceAll(source, target);
      return value;
    }
    if (value instanceof Date || value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    return value;
  };
  return Object.fromEntries(
    Object.entries(history)
      .filter(
        ([table]) =>
          !sameOwner ||
          ![
            'public.user',
            'public.account',
            'public.session',
            'access.account',
            'access.lifecycle_coordination',
          ].includes(table),
      )
      .map(([table, rows]) => [
        table,
        rows.map((row) => ({
          ...(replace(row) as Row),
          ...(table.startsWith('access.') ? { route } : {}),
          ...(table === 'core.receipt' ? { partition_no: route >>> 4 } : {}),
        })),
      ]),
  );
}

test(
  'native completion growth independent of receipt history',
  async () => {
    let warmupBody: { account_id: string; token: string; new_password: string };
    const report = await checkGrowth(db, {
      name: 'native recovery completion with all Auth and Access queries',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      scales: [256, 1024, 4096],
      repetitions,
      async grow(_db, scale, previous) {
        const route = routeOf(accountId)!;
        const population = { name: 'recovery history', hotPartition: route >>> 4 };
        if (previous === 0) {
          // Keep account, email, credential and session probes past the small-table scan crossover.
          await seed(
            { pool: authDatabase, admin: authDatabase },
            {
              ...population,
              rows: ({ ordinal }) => {
                const rows = historyRows(10_000 + ordinal, route, false);
                return {
                  'public.user': rows['public.user']!,
                  'public.account': rows['public.account']!,
                  'public.session': rows['public.session']!,
                };
              },
            },
            { from: 0, to: 4096 },
          );
          await seed(
            db,
            {
              ...population,
              rows: ({ ordinal }) => ({
                'access.account': historyRows(10_000 + ordinal, route, false)['access.account']!,
                'access.lifecycle_coordination': historyRows(10_000 + ordinal, route, false)[
                  'access.lifecycle_coordination'
                ]!,
              }),
            },
            { from: 0, to: 4096 },
          );
        }
        const rows = ({ ordinal, route: placed, hot }: { ordinal: number; route: number; hot: boolean }) =>
          historyRows(ordinal, hot ? route : placed, hot);
        await seed(
          { pool: authDatabase, admin: authDatabase },
          {
            ...population,
            rows: (placement) =>
              Object.fromEntries(Object.entries(rows(placement)).filter(([table]) => table.startsWith('public.'))),
          },
          { from: previous, to: scale },
        );
        await seed(
          db,
          {
            ...population,
            rows: (placement) =>
              Object.fromEntries(Object.entries(rows(placement)).filter(([table]) => !table.startsWith('public.'))),
          },
          { from: previous, to: scale },
        );
        // Complete a spare seeded recovery during the default warm-up. Its native
        // verification and unconsumed state come from the pre-completion snapshot.
        const spare = historyRows(20_000 + scale, route, false);
        const spareId = historyId(20_000 + scale, route, accountId);
        const spareToken = `warmup-recovery-${scale}`;
        warmupBody = { account_id: spareId, token: spareToken, new_password: password };
        spare['public.session'] = [];
        spare['access.lifecycle_coordination'] = [];
        spare['public.auth_recovery'] = [{ ...pendingRecovery, account_id: spareId, proof_hash: digest(spareToken) }];
        spare['public.verification'] = spare['public.verification']!.map((row) => ({
          ...row,
          identifier: `reset-password:${spareToken}`,
        }));
        spare['access.account'] = spare['access.account']!.map((row) => ({
          ...row,
          minimum_authn_epoch: pendingAccount.minimum_authn_epoch,
          authn_fenced: pendingAccount.authn_fenced,
          fence_receipt_id: historyId(20_000 + scale, route, pendingAccount.fence_receipt_id as string),
        }));
        await seed(
          { pool: authDatabase, admin: authDatabase },
          {
            ...population,
            rows: () => Object.fromEntries(Object.entries(spare).filter(([table]) => table.startsWith('public.'))),
          },
          { from: 0, to: 1 },
        );
        await seed(
          db,
          {
            ...population,
            rows: () => Object.fromEntries(Object.entries(spare).filter(([table]) => !table.startsWith('public.'))),
          },
          { from: 0, to: 1 },
        );
      },
      async warmup() {
        expect((await request('/recovery/complete', warmupBody)).status).toBe(200);
        expect((await request('/recovery/complete', warmupBody)).status).toBe(200);
      },
      async operation() {
        await recover();
      },
    });
    console.info('Native recovery completion Cost:', JSON.stringify(report.samples));
    expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
    for (const sample of report.samples) {
      for (const table of [
        'public.auth_recovery_establishment',
        'public.auth_barrier_proof',
        'public.auth_recovery',
        'public.auth_effect_receipt',
        'public.account',
        'access.account',
        'access.lifecycle_fence_receipt',
        'core.receipt',
      ])
        expect(sample.cost.relations?.[table]).toBeDefined();
    }
  },
  growthTimeout,
);
