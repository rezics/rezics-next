import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { newId } from '../../src/route/route.ts';
import {
  activateProfile,
  activeProfile,
  bootstrapProfile,
  publishProfile,
  readProfile,
} from '../../src/presentation/profiles.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-57e3a2d00001',
  clientId: 'web',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const profile = (text: string): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [{ type: 'Heading', props: { id: 'title', text, level: 2 } }] },
  bases: [],
  types: [],
  routes: [],
});
const seededProfile = (ordinal: number): PresentationProfile =>
  profile(`population-${String(ordinal).padStart(5, '0')}`);
const ordinalsPerScale = 500;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const corePositionBase = BigInt(Date.now()) * 100_000n;
let db: GrowthDatabase;

function options() {
  return { actor, idempotencyKey: randomUUID(), digest: new Uint8Array(32).fill(3), authorize: async () => true };
}

function profilePopulation(name: string, withActivations = true): Population {
  return {
    name,
    hotPartition: 0,
    hotShare: 1,
    // Rows match profiles-publish.sql and profiles-activate.sql: fixed-size validated bodies and FK-linked heads.
    rows: ({ ordinal }) => {
      const profileBody = seededProfile(ordinal);
      const digest = profileDigest(profileBody);
      return {
        'presentation.profile': [
          {
            route: 0,
            digest,
            body: profileBody,
            recorded_transaction_id: newId(0),
          },
        ],
        ...(withActivations
          ? {
              'presentation.profile_activation': [
                {
                  route: 0,
                  head: ordinal + 2 + Math.floor(ordinal / ordinalsPerScale) * 1_000,
                  digest,
                  recorded_transaction_id: newId(0),
                },
              ],
            }
          : {}),
      };
    },
  };
}

function commandPopulation(name: string, includeReceipt = true): Population {
  return {
    name,
    hotPartition: 0,
    hotShare: 1,
    // Rows match the receipted command writes: one receipt, outbox event and write basis at partition zero.
    rows: ({ ordinal }) => {
      const transactionId = newId(0);
      const category = name.includes('publish') ? 0 : name.includes('activate') ? 50_000 : 100_000;
      const position = corePositionBase + BigInt(category + ordinal);
      const seededDigest = `sha256:${ordinal.toString(16).padStart(64, '0')}`;
      const publishing = name.includes('publish');
      const eventData = publishing ? { digest: seededDigest } : { digest: seededDigest, head: ordinal + 1 };
      return {
        'core.outbox': [
          {
            partition_no: 0,
            position,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: newId(0),
            type: publishing
              ? 'com.rezics.presentation.profile.published.v1'
              : 'com.rezics.presentation.profile.activated.v1',
            subject: '00000000-0000-8000-8000-000000000000',
            data: eventData,
            recorded_at: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: 0,
            transaction_id: transactionId,
            epoch: 1,
            position,
            principal_kind: 'account',
            principal_id: actor.accountId,
            client_id: actor.clientId,
            requested_by: actor.requestedBy,
            recorded_at: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
        ...(includeReceipt
          ? {
              'core.receipt': [
                {
                  partition_no: 0,
                  principal_kind: 'account',
                  principal_id: actor.accountId,
                  command_kind: publishing ? 'presentation.publish' : 'presentation.activate',
                  idempotency_key: `${name}-${ordinal}`,
                  request_digest: Buffer.alloc(32, 4),
                  epoch: 1,
                  position,
                  transaction_id: transactionId,
                  response: publishing
                    ? { digest: seededDigest, created: true }
                    : { digest: seededDigest, head: ordinal + 1 },
                  created_at: new Date('2026-01-01T00:00:00.000Z'),
                },
              ],
            }
          : {}),
      };
    },
  };
}

function growthPopulation(
  name: string,
  populationOptions: { activations?: boolean; command?: boolean; receipt?: boolean } = {},
): Population {
  const profiles = profilePopulation(name, populationOptions.activations ?? true);
  const command = populationOptions.command ? commandPopulation(name, populationOptions.receipt ?? true) : undefined;
  return {
    name,
    hotPartition: 0,
    hotShare: 1,
    // Combined rows preserve the production shapes for presentation profiles and any command history being grown.
    rows: (placement) => ({
      ...profiles.rows!(placement),
      ...(command ? command.rows!(placement) : {}),
    }),
  };
}

async function grow(database: GrowthDatabase, population: Population, scale: number, previous: number) {
  await seed({ pool: database.pool, admin: database.admin }, population, {
    from: previous * ordinalsPerScale,
    to: scale * ordinalsPerScale,
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
beforeEach(async () => {
  await db.admin.query(
    'TRUNCATE presentation.profile_activation, presentation.profile, core.outbox, editorial.write_basis, core.receipt',
  );
});
afterAll(async () => {
  await db?.close();
});

test('Profile publish stays within its bound as P grows', async () => {
  const database = db;
  const anchor = profile('anchor-publish');
  await publishProfile(database.pool, { ...options(), profile: anchor });
  const population = growthPopulation('publish-growth', { activations: false, command: true });
  const report = await checkGrowth(database, {
    name: 'Profile publish',
    scales: [1, 4, 16],
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d, _scale, repetition) =>
      publishProfile(d.pool, {
        ...options(),
        idempotencyKey: `publish-${repetition}`,
        profile: profile(`measured-publish-${repetition}`),
      }),
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 4, 16]);
}, 90_000);

test('Profile activate stays within its bound as P grows', async () => {
  const database = db;
  const anchor = profile('anchor-activate');
  await publishProfile(database.pool, { ...options(), profile: anchor });
  const anchorDigest = profileDigest(anchor);
  const population = growthPopulation('activate-growth', { command: true });
  const scaleStartRepetition = (scale: number) => (scale === 1 ? 0 : scale === 4 ? 6 : 12);
  const lastSeededHead = (scale: number) => {
    const ordinal = scale * ordinalsPerScale - 1;
    return ordinal + 2 + Math.floor(ordinal / ordinalsPerScale) * 1_000;
  };
  await checkGrowth(database, {
    name: 'Profile activate',
    scales: [1, 4, 16],
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d, scale, repetition) =>
      activateProfile(d.pool, {
        ...options(),
        idempotencyKey: `activate-${repetition}`,
        profileDigest: anchorDigest,
        expectedHead: lastSeededHead(scale) + repetition - scaleStartRepetition(scale),
      }),
  });
}, 90_000);

test('Profile read stays within its bound as P grows', async () => {
  const database = db;
  const anchor = profile('anchor-read');
  await publishProfile(database.pool, { ...options(), profile: anchor });
  const population = growthPopulation('read-growth', { activations: false });
  await checkGrowth(database, {
    name: 'Profile read',
    scales: [1, 4, 16],
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d) => readProfile(d.pool, profileDigest(anchor)),
  });
}, 90_000);

test('Active profile lookup stays within its bound as P grows', async () => {
  const database = db;
  await bootstrapProfile(database.pool, profile('anchor-active'));
  const population = growthPopulation('active-growth');
  await checkGrowth(database, {
    name: 'Active profile lookup',
    scales: [1, 4, 16],
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d) => activeProfile(d.pool),
  });
}, 90_000);

test('Profile bootstrap stays within its bound as P grows', async () => {
  const database = db;
  const anchor = profile('anchor-bootstrap');
  await bootstrapProfile(database.pool, anchor);
  const population = growthPopulation('bootstrap-growth', { command: true, receipt: false });
  await checkGrowth(database, {
    name: 'Profile bootstrap',
    scales: [1, 4, 16],
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d) => bootstrapProfile(d.pool, anchor),
  });
}, 90_000);

test('cold hot evicted and cross-pool profile reads stay bounded at 1x 8x and 64x history', async () => {
  const database = db;
  const anchor = profile('retention-growth-anchor');
  await bootstrapProfile(database.pool, anchor);
  const digest = profileDigest(anchor);
  const other = database.openPool({ max: 1 });
  const population = growthPopulation('retention-growth', { activations: false });
  const report = await checkGrowth(database, {
    name: 'Profile retention lifecycle',
    scales: [1, 8, 64],
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: async (d) => {
      const first = await readProfile(d.pool, digest);
      expect(await readProfile(other, digest)).toBe(first);
      for (let n = 0; n < 4; n++) {
        const body = seededProfile(n);
        expect(await readProfile(d.pool, profileDigest(body))).toEqual(body);
      }
      const reloaded = await activeProfile(other);
      expect(reloaded).toEqual({ digest, head: 1, profile: anchor });
      expect(reloaded!.profile).not.toBe(first);
      expect(Object.isFrozen(reloaded!.profile)).toBe(true);
      expect(await readProfile(other, `sha256:${'f'.repeat(64)}`)).toBeNull();
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
}, 90_000);
