import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import {
  publishRelease,
  activateRelease,
  readRelease,
  activeRelease,
  bootstrapRelease,
} from '../../src/semantic/definitions.ts';
import { checkTyped } from '../../src/semantic/rules.ts';
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
const release = (version: string): Release => ({
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://rezics.com/catalogue/test', version },
  generator: { name: 'test', version: '1' },
  prefixes: { schema: 'http://schema.org/' },
  types: {
    'schema:Person': {
      iri: 'http://schema.org/Person',
      labels: { en: 'person' },
      mappings: [],
      properties: ['schema:url'],
    },
  },
  properties: {
    'schema:url': {
      iri: 'http://schema.org/url',
      labels: { en: 'URL' },
      mappings: [],
      datatype: 'url',
      multivalued: false,
      qualifiers: [],
      value: valueSchema('url'),
    },
  },
});
const body = release('1.0.0');
const digest = releaseDigest(body);
const seededRelease = (ordinal: number): Release => release(`population-${String(ordinal).padStart(3, '0')}`);
let db: GrowthDatabase;
const population: Population = {
  name: 'semantic-definition-revisions',
  hotPartition: 0,
  hotShare: 1,
  // Release rows match definitions-publish.sql: each digest identifies its validated, fixed-size JSON body.
  rows: ({ ordinal }) => {
    const releaseBody = seededRelease(ordinal);
    return {
      'semantic.definition_release': [
        {
          route: 0,
          digest: releaseDigest(releaseBody),
          body: releaseBody,
          recorded_transaction_id: '00000000-0000-0000-0000-000000000000',
        },
      ],
    };
  },
};
const auth = async () => true;
function options() {
  return { actor, idempotencyKey: randomUUID(), digest: new Uint8Array(32).fill(3), authorize: auth };
}
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
async function grow(database: GrowthDatabase, scale: number, previous: number) {
  await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
}
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
beforeEach(async () => {
  await db.admin.query('TRUNCATE semantic.definition_activation, semantic.definition_release');
});
afterAll(async () => {
  await db?.close();
});

test('Definition publish stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-publish');
  await publishRelease(database.pool, { ...options(), release: anchor });
  const report = await checkGrowth(database, {
    name: 'Definition publish',
    bounds,
    grow: (d, s, p) => grow(d, s, p),
    operation: (d, _s, r) =>
      publishRelease(d.pool, { ...options(), idempotencyKey: `publish-${r}`, release: release(`measured-${r}`) }),
  });
  expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
}, 90000);

test('Definition activate stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-activate');
  await publishRelease(database.pool, { ...options(), release: anchor });
  const anchorDigest = releaseDigest(anchor);
  await activateRelease(database.pool, { ...options(), releaseDigest: anchorDigest, expectedHead: null });
  await checkGrowth(database, {
    name: 'Definition activate',
    bounds,
    grow: (d, s, p) => grow(d, s, p),
    operation: (d, _s, r) =>
      activateRelease(d.pool, {
        ...options(),
        idempotencyKey: `activate-${r}`,
        releaseDigest: anchorDigest,
        expectedHead: r + 1,
      }),
  });
}, 90000);

test('Definition read stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-read');
  await publishRelease(database.pool, { ...options(), release: anchor });
  await checkGrowth(database, {
    name: 'Definition read',
    bounds,
    grow: (d, s, p) => grow(d, s, p),
    operation: (d) => readRelease(d.pool, releaseDigest(anchor)),
  });
}, 90000);

test('Active definition lookup stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-active');
  await bootstrapRelease(database.pool, anchor);
  await checkGrowth(database, {
    name: 'Active definition lookup',
    bounds,
    grow: (d, s, p) => grow(d, s, p),
    operation: (d) => activeRelease(d.pool),
  });
}, 90000);

test('Definition bootstrap stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-bootstrap');
  await bootstrapRelease(database.pool, anchor);
  await checkGrowth(database, {
    name: 'Definition bootstrap',
    bounds,
    grow: (d, s, p) => grow(d, s, p),
    operation: (d) => bootstrapRelease(d.pool, anchor),
  });
}, 90000);

test('Typed validation stays within its bound as D grows', async () => {
  const database = db;
  const operation = async () => checkTyped(body, digest, { type: 'schema:Person', statements: {} });
  await checkGrowth(database, {
    name: 'Typed validation',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: (d, s, p) => grow(d, s, p),
    operation,
  });
}, 90000);
