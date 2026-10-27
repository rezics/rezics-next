import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const source = subjectSource(pool);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(21)]]) };
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const ACTIONS = [
  'subject:create',
  'subject:read',
  'subject:merge',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
];
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000053' };
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await bootstrapRelease(pool, bundledRelease);
});
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(22),
  writeRate: realAccess.writeRate,
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function create(body: unknown) {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        'idempotency-key': `"${randomUUID()}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  const result = (await response.json()) as { subject?: Record<string, any>; code?: string };
  expect([response.status, result.code]).toEqual([201, undefined]);
  return result.subject!;
}
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: value(content),
  ...extra,
});

test('the source marks descriptive facets and excludes relation statements', async () => {
  const author = await create({ type: 'schema:Person', labels: { en: 'Author' } });
  const role = await create({ type: 'skos:Concept', labels: { en: 'Author role' } });
  const book = await create({
    type: 'schema:Book',
    labels: { en: 'Faceted book' },
    statements: {
      'schema:author': [
        statement('schema:author', author.id, {
          qualifiers: [statement('wdt:P1932', 'H. R. Haggard'), statement('wdt:P3831', role.id)],
        }),
      ],
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    },
  });
  const recipe = await create({
    type: 'schema:Recipe',
    labels: { en: 'Faceted recipe' },
    statements: {
      'schema:datePublished': [
        statement('schema:datePublished', {
          time: '-0500-00-00T00:00:00Z',
          precision: 9,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        }),
      ],
      'schema:recipeYield': [statement('schema:recipeYield', { amount: '+4', unit: '1' })],
    },
  });
  const episode = await create({
    type: 'schema:Episode',
    labels: { en: 'Unpatterned string' },
    statements: { 'schema:episodeNumber': [statement('schema:episodeNumber', 'Special episode')] },
  });

  const subjects = [book, recipe, episode];
  const groups = new Map<number, string[]>();
  for (const subject of subjects) {
    const partition = subjectPartition(subject.id);
    const ids = groups.get(partition) ?? [];
    ids.push(subject.id);
    groups.set(partition, ids);
  }
  const indexed = new Map<string, typeof book & { statements: Record<string, any>[] }>();
  for (const [partition, ids] of groups) {
    const snapshot = await source.read(partition, ids);
    for (const subject of snapshot.subjects) indexed.set(subject.id, subject as never);
  }

  expect(indexed.get(book.id)!.statements.find(({ property }) => property === 'schema:author')).toBeUndefined();
  expect(indexed.get(book.id)!.statements.find(({ property }) => property === 'schema:inLanguage')).toEqual({
    property: 'schema:inLanguage',
    value: 'ja',
    facet: { kind: 'code' },
  });
  expect(indexed.get(recipe.id)!.statements.find(({ property }) => property === 'schema:datePublished')).toEqual({
    property: 'schema:datePublished',
    value: '-0500-00-00T00:00:00Z',
    facet: { kind: 'time', year: -500 },
  });
  expect(indexed.get(recipe.id)!.statements.find(({ property }) => property === 'schema:recipeYield')).toEqual({
    property: 'schema:recipeYield',
    value: '+4',
    facet: { kind: 'quantity', amount: 4, unit: '1' },
  });
  const unpatterned = indexed.get(episode.id)!.statements.find(({ property }) => property === 'schema:episodeNumber');
  expect(unpatterned).toEqual({ property: 'schema:episodeNumber', value: 'Special episode' });
});
