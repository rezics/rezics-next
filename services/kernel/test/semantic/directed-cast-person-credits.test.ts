import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { cataloguePageMetadata } from '../../src/presentation/semantic-page.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createReleasedRelationDirectionResolver } from '../../src/semantic/released-relation-direction.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 50 });
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000001' };
const actions = ['subject:create', 'subject:read', 'statement:propose'];
const realAccess = await createRealAccess(admin, accounts, actions);
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(13)]]) };
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey: new Uint8Array(32).fill(14),
  writeRate: realAccess.writeRate,
});

afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});
beforeAll(async () => {
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' ? { 'idempotency-key': `"${randomUUID()}"` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

const statement = (property: string, content: unknown, qualifiers: unknown[] = []) => ({
  property: { id: property },
  value: { type: 'value', content },
  ...(qualifiers.length ? { qualifiers } : {}),
});

async function create(type: string, label: string, statements?: Record<string, unknown[]>) {
  const result = await call('POST', '/v1/subjects', {
    type,
    labels: { en: label },
    ...(statements ? { statements } : {}),
  });
  expect(result.response.status, JSON.stringify(result.body)).toBe(201);
  return result.body.subject as { id: string; statements: Record<string, any[]> };
}

test('released inverse descriptors keep the original cast property and pin qualifiers to one statement', async () => {
  const directions = createReleasedRelationDirectionResolver(bundledRelease, bundledDigest);
  const person = directions.resolve('schema:Person', 'wdt:P725', 'inverse');
  const character = directions.resolve('wd:Q95074', 'schema:character', 'inverse');
  expect(person.state).toBe('admitted');
  expect(person.state === 'admitted' && person.property).toBe('wdt:P725');
  expect(person.state === 'admitted' && person.release).toBe(bundledDigest);
  expect(person.state === 'admitted' && person.qualifiers.map(({ id }) => id)).toContain('wdt:P453');
  expect(character.state === 'admitted' && character.property).toBe('schema:character');
  expect(
    cataloguePageMetadata(bundledRelease, bundledDigest, 'schema:Person')?.directions?.find(
      (entry) => entry.property === 'wdt:P725' && entry.direction === 'inverse',
    ),
  ).toMatchObject({ state: 'admitted', property: 'wdt:P725', release: bundledDigest });
  expect(
    cataloguePageMetadata(bundledRelease, bundledDigest, 'wd:Q95074')?.directions?.find(
      (entry) => entry.property === 'schema:character' && entry.direction === 'inverse',
    ),
  ).toMatchObject({ state: 'admitted', property: 'schema:character', release: bundledDigest });
  expect(directions.resolve('schema:Person', 'rezics:voiceActorOf', 'inverse')).toMatchObject({
    state: 'admitted',
    property: 'wdt:P725',
    direction: 'inverse',
  });
  expect(directions.resolve('wd:Q95074', 'wdt:P453', 'inverse')).toMatchObject({
    state: 'unsupported',
    reason: 'missing-inverse',
  });
  expect(
    createReleasedRelationDirectionResolver(bundledRelease, 'sha256:stale').resolve(
      'schema:Person',
      'wdt:P725',
      'inverse',
    ),
  ).toMatchObject({ state: 'unavailable', reason: 'stale-release' });

  const role = await create('skos:Concept', 'Narration');
  const actor = await create('schema:Person', 'Voice actor');
  const characterSubject = await create('wd:Q95074', 'The traveller');
  const works: { id: string }[] = [];
  for (const [index, language] of ['en', 'ja'].entries()) {
    const credited = `Credit ${index + 1}`;
    const work = await create('schema:Movie', `Work ${index + 1}`, {
      'schema:inLanguage': [statement('schema:inLanguage', language)],
      'schema:character': [
        statement('schema:character', characterSubject.id, [
          statement('wdt:P3831', role.id),
          statement('wdt:P1932', credited),
          statement('rezics:spoilerLevel', { amount: '+2', unit: '1' }),
        ]),
      ],
      'wdt:P725': [
        statement('wdt:P725', actor.id, [
          statement('wdt:P3831', role.id),
          statement('wdt:P1932', credited),
          statement('wdt:P453', characterSubject.id),
        ]),
      ],
    });
    works.push(work);
  }

  const appearances = await call('GET', `/v1/subjects/${characterSubject.id}/links?property=schema%3Acharacter`);
  expect(appearances.response.status).toBe(200);
  expect(appearances.body.links.map((link: any) => link.subject).sort()).toEqual(works.map(({ id }) => id).sort());
  expect(appearances.body.links.every((link: any) => link.property === 'schema:character')).toBe(true);
  for (const link of appearances.body.links) {
    const assertion = link.assertion;
    expect(assertion.property.id).toBe('schema:character');
    expect(assertion.qualifiers.map((item: any) => item.property.id)).toEqual([
      'wdt:P3831',
      'wdt:P1932',
      'rezics:spoilerLevel',
    ]);
  }

  const first = await call('GET', `/v1/subjects/${actor.id}/links?property=wdt%3AP725&limit=1`);
  expect(first.response.status).toBe(200);
  expect(first.body.links).toHaveLength(1);
  expect(first.body.links[0].property).toBe('wdt:P725');
  expect(first.body.links[0].assertion.qualifiers.map((item: any) => item.property.id)).toEqual([
    'wdt:P3831',
    'wdt:P1932',
    'wdt:P453',
  ]);
  expect(first.body.links[0].assertion.rezics.release).toBe(bundledDigest);
  expect(first.body.next).toBeString();
  const second = await call(
    'GET',
    `/v1/subjects/${actor.id}/links?property=wdt%3AP725&limit=1&cursor=${encodeURIComponent(first.body.next)}`,
  );
  expect(second.response.status).toBe(200);
  expect(second.body.links).toHaveLength(1);
  expect(new Set([first.body.links[0].subject, second.body.links[0].subject])).toEqual(
    new Set(works.map(({ id }) => id)),
  );
});
