import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type Row,
} from '../../kernel/test/support/growth.ts';

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

test('consent erasure scheduling stays bounded as unrelated erasure rows and consents grow', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    const auth = await makeAuth(db.pool);
    await auth.internal.registerClient({ clientId: 'schedule-growth-client', firstParty: false, scopes: ['read'] });
    const unrelated = scheduledPopulation('schedule-growth-client', 'schedule-unrelated', true);
    const measured: Population = {
      name: 'schedule-measured',
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const id = `schedule-owner-${ordinal}`;
        return { 'public.user': [user(id)], 'public.auth_consent': [consent(id, 'schedule-growth-client')] };
      },
    };
    let nextRepetition = 0;
    const report = await checkGrowth(db, {
      name: 'consent erasure scheduling',
      scales: [256, 1024, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(current, scale, previous) {
        await seed(current, unrelated, { from: previous, to: scale });
        const end = nextRepetition + 2;
        await seed(current, measured, { from: nextRepetition, to: end });
        nextRepetition = end;
      },
      async operation(current, _scale, repetition) {
        const owner = `schedule-owner-${repetition}`;
        await auth.internal.eraseAccount(owner);
        expect(
          (await current.admin.query('SELECT account_id FROM auth_consent WHERE account_id=$1', [owner])).rowCount,
        ).toBe(1);
        expect(
          (await current.admin.query('SELECT account_id FROM auth_consent_erasure WHERE account_id=$1', [owner]))
            .rowCount,
        ).toBe(1);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  } finally {
    await db.close();
    fixture.close();
  }
});

test('one fixed consent erasure batch stays bounded as live consent and future schedules grow', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
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
    const due: Population = {
      name: 'maintenance-due',
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const id = `maintenance-erased-${ordinal}`;
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
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(current, scale, previous) {
        await seed(current, live, { from: previous, to: scale });
        const warmupEnd = nextDueOwner + 100;
        await seed(current, due, { from: nextDueOwner, to: warmupEnd });
        const measuredEnd = warmupEnd + 100;
        await seed(current, due, { from: warmupEnd, to: measuredEnd });
        measuredOwners.set(
          scale,
          Array.from({ length: 100 }, (_, index) => `maintenance-erased-${warmupEnd + index}`),
        );
        nextDueOwner = measuredEnd;
      },
      async warmup(_current) {
        expect(await auth.internal.eraseDueConsents(100)).toBe(100);
      },
      async operation(current, scale) {
        const owners = measuredOwners.get(scale)!;
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
