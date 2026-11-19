import { nativeFixture, nativeFixtureResources } from './support/erasure-native.ts';
import { beforeNativeKernelTests, nativeKernelSetupTimeout } from './support/native-kernel.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import { AUTH_MAINTENANCE_SCHEDULE } from '../src/maintenance.ts';
import { WORKFLOW_RETENTION_SCHEDULE } from '../src/retention.ts';
import type { GrowthDatabase, Population, Row } from '../../kernel/test/support/growth.ts';

// The growth pool imports Kernel partition SQL. Install Reylo before loading that pool.
beforeNativeKernelTests();
async function growthFixture() {
  const { checkGrowth, seed } = await import('../../kernel/test/support/growth.ts');
  const { openAuthGrowthDatabase } = await import('./support/auth-growth-database.ts');
  return { checkGrowth, seed, openAuthGrowthDatabase };
}

const instant = new Date('2026-01-01T00:00:00.000Z');
const future = new Date('2099-01-01T00:00:00.000Z');
const past = new Date('2000-01-01T00:00:00.000Z');

function user(owner: string): Row {
  return {
    id: owner,
    name: '',
    email: `${owner}@example.test`,
    emailVerified: false,
    createdAt: instant,
    updatedAt: instant,
  };
}

function consent(owner: string, client: string): Row {
  return { account_id: owner, client_id: client, scopes: ['read'] };
}

async function makeAuth(database: GrowthDatabase['pool']) {
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'growth-consent-erasure',
    alg: 'ES256',
  };
  return createAuthService({
    database,
    issuer: 'https://growth-consent-erasure.auth.test',
    audience: 'https://api.growth-consent-erasure.test',
    secret: 'growth-consent-erasure-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      readAccount: async (accountId) => ({
        accountId,
        kind: 'actor',
        state: 'deleted',
        automated: false,
        fenced: true,
        authnEpoch: 2,
      }),
      authorizeProvisioning: async () => {
        throw new Error('Not used');
      },
    }),
  });
}

function scheduledPopulation(client: string, name: string, futureDue: boolean): Population {
  return {
    name,
    hotPartition: 0,
    rows: ({ ordinal }) => {
      const id = `${name}-${String(ordinal).padStart(8, '0')}`;
      return {
        'public.user': [user(id)],
        'public.auth_consent': [consent(id, client)],
        'public.auth_consent_erasure': [{ account_id: id, due_at: futureDue ? future : past }],
      };
    },
  };
}

async function expectErased(current: GrowthDatabase, owners: string[]) {
  expect(
    (
      await current.admin.query(
        'SELECT count(*)::integer AS count FROM auth_consent WHERE account_id=ANY($1::text[])',
        [owners],
      )
    ).rows[0]!.count,
  ).toBe(0);
  expect(
    (
      await current.admin.query(
        'SELECT count(*)::integer AS count FROM auth_consent_erasure WHERE account_id=ANY($1::text[])',
        [owners],
      )
    ).rows[0]!.count,
  ).toBe(0);
}

describe('active account deletion', () => {
  const resources = nativeFixtureResources();
  let f: Awaited<ReturnType<typeof nativeFixture>>;
  let db: GrowthDatabase;
  const clientId = 'schedule-growth-client';
  const owners: string[] = [];

  beforeAll(async () => {
    const { openAuthGrowthDatabase } = await growthFixture();
    f = await nativeFixture({
      openPool: async (url) => {
        db = await openAuthGrowthDatabase(url);
        resources.own('Growth pools', () => db.close());
        return db.openPool();
      },
    });
    resources.own('Native erasure fixture', () => f.close());
    await DBOS.pauseSchedule(AUTH_MAINTENANCE_SCHEDULE);
    await DBOS.pauseSchedule(WORKFLOW_RETENTION_SCHEDULE);
    const auth = f.host.service.internal;
    await auth.registerClient({ clientId, firstParty: false, scopes: ['read'] });

    // Interrupt the foreground drain after the deletion workflow transfers its source.
    const eraseAccount = auth.eraseAccount;
    let interruptedOwner: string | undefined;
    auth.eraseAccount = async (owner) => {
      interruptedOwner = owner;
      throw new Error('Interrupted before the foreground erasure drain');
    };
    try {
      for (let i = 0; i < 6; i++) {
        const person = await f.person(`schedule-owner-${i}`);
        const owner = person.accountId;
        await db.admin.query('INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)', [
          owner,
          clientId,
          ['read'],
        ]);
        expect((await f.delete(person)).status).toBe(503);
        expect(interruptedOwner).toBe(owner);
        expect(
          (
            await db.admin.query('SELECT source_discharged_at,user_deleted_at FROM auth_erasure WHERE account_id=$1', [
              owner,
            ])
          ).rows[0],
        ).toEqual({ source_discharged_at: expect.any(Date), user_deleted_at: null });
        owners.push(owner);
      }
    } finally {
      auth.eraseAccount = eraseAccount;
    }
    // DBOS owns background lock transactions on this pool even with its schedules paused.
    // All six sources are discharged. The foreground Auth drain only needs the service and its pool.
    await f.host.workflows.close();
  }, nativeKernelSetupTimeout);
  afterAll(() => resources.close());

  test('consent erasure scheduling stays bounded as unrelated erasure rows and consents grow', async () => {
    const { checkGrowth, seed } = await growthFixture();
    const unrelated = scheduledPopulation(clientId, 'schedule-unrelated', true);
    const report = await checkGrowth(db, {
      name: 'consent erasure scheduling',
      scales: [256, 1024, 4096],
      repetitions: 1,
      warmups: 1,
      captureMode: 'cost-folded',
      warmupSettlementOnly: true,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: (current, scale, previous) => seed(current, unrelated, { from: previous, to: scale }),
      async operation(current, _scale, repetition) {
        const owner = owners[repetition]!;
        await f.host.service.internal.eraseAccount(owner);
        expect(
          (
            await current.admin.query(
              `SELECT e.user_deleted_at, s.due_at=e.consent_due_at AS original_cutoff
             FROM auth_erasure e JOIN auth_consent_erasure s USING(account_id)
             JOIN auth_consent c USING(account_id) WHERE e.account_id=$1 AND c.client_id=$2`,
              [owner, clientId],
            )
          ).rows,
        ).toEqual([{ user_deleted_at: expect.any(Date), original_cutoff: true }]);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  });
});

test('one fixed consent erasure batch stays bounded as live consent and future schedules grow', async () => {
  const { checkGrowth, seed, openAuthGrowthDatabase } = await growthFixture();
  const fixture = testDatabase();
  const db = await openAuthGrowthDatabase(fixture.url);
  try {
    const auth = await makeAuth(db.pool);
    const clients = ['maintenance-growth-client-a', 'maintenance-growth-client-b'];
    for (const clientId of clients)
      await auth.internal.registerClient({ clientId, firstParty: false, scopes: ['read'] });
    const live: Population = {
      name: 'maintenance-live',
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const id = `maintenance-live-${String(ordinal).padStart(8, '0')}`;
        return {
          'public.user': [user(id)],
          'public.auth_consent': clients.map((client) => consent(id, client)),
          'public.auth_consent_erasure': [{ account_id: id, due_at: future }],
        };
      },
    };
    const dueOwner = (ordinal: number) => `maintenance-erased-${String(ordinal).padStart(8, '0')}`;
    const due: Population = {
      name: 'maintenance-due',
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const id = dueOwner(ordinal);
        return {
          'public.auth_consent': clients.map((client) => consent(id, client)),
          'public.auth_consent_erasure': [{ account_id: id, due_at: past }],
        };
      },
    };
    let nextDueOwner = 0;
    const measuredOwners = new Map<number, string[]>();
    const report = await checkGrowth(db, {
      name: 'one fixed consent erasure batch',
      scales: [256, 1024, 4096],
      repetitions: 1,
      warmups: 1,
      captureMode: 'cost-folded',
      warmupSettlementOnly: true,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(current, scale, previous) {
        await seed(current, live, { from: previous, to: scale });
        const warmupEnd = nextDueOwner + 100;
        await seed(current, due, { from: nextDueOwner, to: warmupEnd });
        const measuredEnd = warmupEnd + 100;
        await seed(current, due, { from: warmupEnd, to: measuredEnd });
        measuredOwners.set(
          scale,
          Array.from({ length: 100 }, (_, index) => dueOwner(warmupEnd + index)),
        );
        nextDueOwner = measuredEnd;
      },
      async warmup(_current) {
        expect(await auth.internal.eraseDueConsents(100)).toBe(100);
        expect(await auth.internal.eraseDueConsents(100)).toBe(100);
      },
      async operation(current, scale) {
        const owners = measuredOwners.get(scale)!;
        expect(await auth.internal.eraseDueConsents()).toBe(1);
        expect(
          (await current.admin.query('SELECT client_id FROM auth_consent WHERE account_id=$1', [owners[0]])).rows,
        ).toEqual([{ client_id: clients[1] }]);
        expect(await auth.internal.eraseDueConsents(99)).toBe(99);
        expect(await auth.internal.eraseDueConsents(100)).toBe(100);
        await expectErased(current, owners);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  } finally {
    await db.close();
    fixture.close();
  }
});
