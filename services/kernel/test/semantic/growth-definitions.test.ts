import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { newId } from '../../src/route/route.ts';
import {
  publishRelease,
  activateRelease,
  readRelease,
  activeRelease,
  bootstrapRelease,
} from '../../src/semantic/definitions.ts';
import { checkTyped } from '../../src/semantic/rules.ts';
import type { AccountActor } from '../../src/request/access.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

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
      bases: [],
      properties: ['schema:url'],
      facets: [],
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
const seededRelease = (ordinal: number): Release => release(`population-${String(ordinal).padStart(5, '0')}`);
const ordinalsPerScale = 500;
const scales = [1, 4, 16] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const corePositionBase = BigInt(Date.now()) * 100_000n;
let db: GrowthDatabase;

function options() {
  return { actor, idempotencyKey: randomUUID(), digest: new Uint8Array(32).fill(3), authorize: async () => true };
}

function definitionPopulation(name: string, withActivations = true): Population {
  return {
    name,
    hotPartition: 0,
    hotShare: 1,
    // Rows match definitions-publish.sql and definitions-activate.sql: fixed-size validated bodies and FK-linked heads.
    rows: ({ ordinal }) => {
      const releaseBody = seededRelease(ordinal);
      const definitionDigest = releaseDigest(releaseBody);
      return {
        'semantic.definition_release': [
          {
            route: 0,
            digest: definitionDigest,
            body: releaseBody,
            recorded_transaction_id: newId(0),
          },
        ],
        ...(withActivations
          ? {
              'semantic.definition_activation': [
                {
                  route: 0,
                  head: ordinal + 2 + Math.floor(ordinal / ordinalsPerScale) * 1_000,
                  digest: definitionDigest,
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
            type: publishing ? 'com.rezics.definitions.published.v1' : 'com.rezics.definitions.activated.v1',
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
                  command_kind: publishing ? 'definitions.publish' : 'definitions.activate',
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
  options: { activations?: boolean; command?: boolean; receipt?: boolean } = {},
): Population {
  const definitions = definitionPopulation(name, options.activations ?? true);
  const command = options.command ? commandPopulation(name, options.receipt ?? true) : undefined;
  return {
    name,
    hotPartition: 0,
    hotShare: 1,
    // Combined rows preserve the production shapes for semantic definitions and any command history being grown.
    rows: (placement) => ({
      ...definitions.rows!(placement),
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
afterAll(async () => {
  await db?.close();
});

// Every relation this file seeds or writes through a command, including the command rows.
const seededRelations = [
  'semantic.definition_release',
  'semantic.definition_activation',
  'core.receipt',
  'core.outbox',
  'editorial.write_basis',
] as const;
type RowCounts = Record<(typeof seededRelations)[number], number>;
type Observation = { title: string; before: RowCounts; after?: RowCounts };
const observations: Observation[] = [];
// Rows the anchor, warm-ups and measured runs of one check add beside its seeded population.
const fixtureRows = 64;
const maxScaleUnits = 16;

async function rowCounts(): Promise<RowCounts> {
  const counts = {} as RowCounts;
  for (const relation of seededRelations) {
    const { rows } = await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${relation}`);
    counts[relation] = rows[0]!.n;
  }
  return counts;
}

async function resetGrowthData() {
  await db.admin.query(`TRUNCATE ${seededRelations.join(', ')}`);
}

/** Runs one growth check from the state `resetGrowthData` leaves, recording the seeded relations' row counts. */
function growthTest(title: string, run: () => Promise<void>) {
  test(
    title,
    async () => {
      await resetGrowthData();
      const observation: Observation = { title, before: await rowCounts() };
      observations.push(observation);
      try {
        await run();
      } finally {
        observation.after = await rowCounts();
      }
    },
    90_000,
  );
}

growthTest('Definition publish stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-publish');
  await publishRelease(database.pool, { ...options(), release: anchor });
  const population = growthPopulation('publish-growth', { activations: false, command: true });
  const report = await checkGrowth(database, {
    name: 'Definition publish',
    scales,
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d, _scale, repetition) =>
      publishRelease(d.pool, {
        ...options(),
        idempotencyKey: `publish-${repetition}`,
        release: release(`measured-publish-${repetition}`),
      }),
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
});

growthTest('Definition activate stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-activate');
  await publishRelease(database.pool, { ...options(), release: anchor });
  const anchorDigest = releaseDigest(anchor);
  const population = growthPopulation('activate-growth', { command: true });
  const scaleStartRepetition = (scale: number) => (scale === 1 ? 0 : scale === 4 ? 6 : 12);
  const lastSeededHead = (scale: number) => {
    const ordinal = scale * ordinalsPerScale - 1;
    return ordinal + 2 + Math.floor(ordinal / ordinalsPerScale) * 1_000;
  };
  await checkGrowth(database, {
    name: 'Definition activate',
    scales,
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d, scale, repetition) =>
      activateRelease(d.pool, {
        ...options(),
        idempotencyKey: `activate-${repetition}`,
        releaseDigest: anchorDigest,
        expectedHead: lastSeededHead(scale) + repetition - scaleStartRepetition(scale),
      }),
  });
});

growthTest('Definition read stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-read');
  await publishRelease(database.pool, { ...options(), release: anchor });
  const population = growthPopulation('read-growth', { activations: false });
  await checkGrowth(database, {
    name: 'Definition read',
    scales,
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d) => readRelease(d.pool, releaseDigest(anchor)),
  });
});

growthTest('Active definition lookup stays within its bound as D grows', async () => {
  const database = db;
  await bootstrapRelease(database.pool, release('anchor-active'));
  const population = growthPopulation('active-growth');
  await checkGrowth(database, {
    name: 'Active definition lookup',
    scales,
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d) => activeRelease(d.pool),
    repetitions: 1,
  });
});

growthTest('Definition bootstrap stays within its bound as D grows', async () => {
  const database = db;
  const anchor = release('anchor-bootstrap');
  await bootstrapRelease(database.pool, anchor);
  const population = growthPopulation('bootstrap-growth', { command: true, receipt: false });
  await checkGrowth(database, {
    name: 'Definition bootstrap',
    scales,
    bounds,
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: (d) => bootstrapRelease(d.pool, anchor),
  });
});

growthTest('Typed validation stays within its bound as D grows', async () => {
  const database = db;
  const population = growthPopulation('typed-validation-growth', { activations: false });
  await checkGrowth(database, {
    name: 'Typed validation',
    scales,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: (d, scale, previous) => grow(d, population, scale, previous),
    operation: async () => checkTyped(body, digest, { type: 'schema:Person', statements: {} }),
  });
});

test('every growth-definitions check starts empty and seeds at most sixteen scale units', async () => {
  const population = growthPopulation('rows-per-ordinal', { command: true });
  const perOrdinal = Object.fromEntries(
    Object.entries(population.rows!(placement(population, 0))).map(([relation, rows]) => [relation, rows.length]),
  ) as Record<(typeof seededRelations)[number], number>;
  const problems: string[] = [];
  expect(observations).toHaveLength(6);
  for (const { title, before, after } of observations) {
    for (const relation of seededRelations) {
      if (before[relation] !== 0)
        problems.push(`${title}: ${relation} holds ${before[relation]} rows before its first grow`);
      const limit = maxScaleUnits * ordinalsPerScale * perOrdinal[relation] + fixtureRows;
      const rows = after?.[relation];
      if (rows === undefined || rows > limit)
        problems.push(`${title}: ${relation} holds ${rows} rows after its check, more than ${limit}`);
    }
  }
  expect(problems).toEqual([]);
});
