import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { proposeStatement } from '../../src/semantic/candidates.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  captureUnforcedIndexes,
  logGrowthSeeding,
  seedSemanticPopulation,
  unrelatedSemanticPopulation,
} from './planner-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const HISTORY_PARTITION = 531;
const UNRELATED_PARTITION = 530;
const routeKey = new Uint8Array(32).fill(61);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
  clientId: 'wikidata-growth',
  scopes: ['subject:create', 'subject:read', 'statement:propose'],
  requestedBy: null,
  authnEpoch: 1,
};
const calendar = 'http://www.wikidata.org/entity/Q1985786';
const time = {
  time: '-1234567890123456-02-29T00:00:00Z',
  precision: 11,
  calendarmodel: calendar,
  timezone: -330,
  before: 1,
  after: 2,
};
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
const id = newId(HISTORY_PARTITION * 16);

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}
function auth(resource: string): CommandAuthorization {
  const route = routeOf(resource);
  if (route === null) throw new TypeError('Expected a routed resource id');
  return {
    action: 'statement:propose',
    resource: { route, id: resource },
    denied: () => new Error('Growth fixture authorization denied'),
    async authorize() {
      return 'execute';
    },
  };
}
async function readCurrent() {
  const response = await kernel.handle(new Request(`http://localhost/v1/subjects/${id}`));
  const body = (await response.json()) as { subject?: { statements?: Record<string, { value: unknown }[]> } };
  if (response.status !== 200) throw new Error(`native read ${response.status}`);
  const value = body.subject?.statements?.['schema:datePublished']?.[0]?.value;
  if (JSON.stringify(value) !== JSON.stringify({ type: 'value', content: time }))
    throw new Error('current public value changed during history growth');
  return body;
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  kernel = createKernel({ pool: db.pool, routeKey, tokens });
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
  await createSubject(db.pool, {
    actor,
    target: { route: routeOf(id)!, id },
    idempotencyKey: randomUUID(),
    digest: digest(id),
    item: {
      type: 'schema:Book',
      labels: { en: 'Wikidata growth anchor' },
      statements: {
        'schema:datePublished': [
          {
            property: { id: 'schema:datePublished' },
            value: { type: 'value', content: time },
            references: [
              {
                parts: [
                  { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/evidence' } },
                ],
              },
            ],
          },
        ],
      },
    },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
});

afterAll(async () => {
  if (db) await db.close();
});

test('bounded time validation and current-head reads stay fixed across unrelated subjects and obsolete revisions', async () => {
  const supported = {
    property: { id: 'schema:datePublished' },
    value: { type: 'value', content: time },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/evidence' } }],
      },
    ],
  };
  expect(checkStatementInput(supported, bundledRelease).violations).toEqual([]);
  for (const content of [
    { ...time, time: `+${'9'.repeat(17)}-02-29T00:00:00Z` },
    { ...time, time: `+${'9'.repeat(16)}-99-99T00:00:00Z` },
    { ...time, after: 9007199254740992 },
  ])
    expect(
      checkStatementInput({ ...supported, value: { type: 'value', content } }, bundledRelease).violations.length,
    ).toBeGreaterThan(0);

  const population = unrelatedSemanticPopulation('growth-wikidata-values-unrelated', UNRELATED_PARTITION);
  const indexed = new Set<number>();
  const report = await checkGrowth(db, {
    name: 'Native Wikidata current-head reads stay bounded across unrelated subjects and obsolete revisions',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    grow: async (_database, scale, previous) => {
      await seedSemanticPopulation({ pool: db.pool, admin: db.admin }, population.population, {
        from: previous,
        to: scale,
      });
      const proposal = {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'ja' },
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/obsolete' } },
            ],
          },
        ],
      };
      for (let ordinal = previous; ordinal < scale; ordinal++)
        await proposeStatement(db.pool, {
          subject: id,
          statement: proposal,
          actor,
          idempotencyKey: randomUUID(),
          digest: digest(`${scale}:${ordinal}`),
          release: { digest: bundledDigest, release: bundledRelease },
          authorization: auth(id),
          deadline: Date.now() + 30_000,
        });
    },
    operation: readCurrent,
    prepare: async (_database, scale) => {
      if (indexed.has(scale)) return;
      await captureUnforcedIndexes(db, 'Native Wikidata current-head read', scale, readCurrent, {
        'semantic.subject': 'subject_pkey',
        'semantic.revision': 'revision_pkey',
        'semantic.fact': ['fact_label', 'fact_terms'],
      });
      indexed.add(scale);
    },
  });
  logGrowthSeeding(report);
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 900_000);
