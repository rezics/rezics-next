import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const access = await createRealAccess(admin, { editor: newId(32000) }, [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
]);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: createWriteRateLimiter({
    secret: 'story-arcs-test-secret-with-32-bytes',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 1000, seconds: 60 } } }),
  }),
  tokens: ring,
  routeKey: new Uint8Array(32).fill(81),
});
const projection = linkProjection(pool);
const holders = new Set<string>();
async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const result = (await response.json()) as any;
  if (response.status !== 200 && response.status !== 201)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const statement = (id: string, content: unknown, qualifiers: unknown[] = []) => ({
  ...snak(id, content),
  qualifiers,
  references: [],
});
async function create(type: string, label: string, statements = {}) {
  const result = await call('POST', '/v1/subjects', { type, labels: { en: label }, statements });
  const id = result.subject.id as string;
  holders.add(id);
  await access.grant({ route: routeOf(id)!, id }, 'editor', 'subject:read');
  return id;
}
async function catchUp() {
  for (const partition of new Set([...holders].map((id) => routeOf(id)! >>> 4))) {
    for (;;) {
      const result = await projection.run(partition);
      if (result.status === 'busy') continue;
      if (result.envelopes === 0) break;
    }
  }
}
let work: string;
let arcs: string[];
let characters: string[];
let role: string;
beforeAll(async () => {
  for (const action of ['definitions:publish', 'definitions:activate', 'subject:create'])
    await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const published = await call('POST', '/v1/definitions/releases', { release: bundledRelease });
  await call('POST', `/v1/definitions/releases/${published.digest}:activate`, { expected_head: null });
  arcs = [];
  for (const name of ['Opening', 'Journey', 'Finale']) arcs.push(await create('wd:Q2620972', name));
  characters = [];
  for (const name of ['Alice', 'Bob', 'Carol', 'Dana']) characters.push(await create('wd:Q95074', name));
  role = await create('skos:Concept', 'Main character');
  work = await create('schema:TVSeries', 'A 24-episode series', {
    'schema:numberOfEpisodes': [statement('schema:numberOfEpisodes', { amount: '+24', unit: '1' })],
    // Deliberately supply the arc statements out of order.
    'rezics:storyArc': [2, 0, 1].map((index) =>
      statement('rezics:storyArc', arcs[index], [
        snak('schema:position', String(index + 1)),
        snak('rezics:firstPart', String(index * 8 + 1)),
        snak('rezics:lastPart', String(index * 8 + 8)),
      ]),
    ),
    'schema:character': [
      statement('schema:character', characters[0], [
        snak('wdt:P3831', role),
        snak('wdt:P518', arcs[0]),
        snak('wdt:P518', arcs[1]),
      ]),
      statement('schema:character', characters[1], [snak('wdt:P518', arcs[0])]),
      statement('schema:character', characters[2], [snak('wdt:P3831', role), snak('wdt:P518', arcs[2])]),
      statement('schema:character', characters[3]),
    ],
  });
  await catchUp();
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function forward(property: string, query = '') {
  return call('GET', `/v1/subjects/${work}/relations?property=${encodeURIComponent(property)}${query}`);
}
test("a work's story arcs page in order with their part ranges", async () => {
  const found: any[] = [];
  let cursor: string | null = null;
  do {
    const page = await forward('rezics:storyArc', `&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    expect(page).not.toHaveProperty('count');
    found.push(...page.relations);
    cursor = page.next;
  } while (cursor);
  expect(found.map((entry) => entry.target)).toEqual(arcs);
  expect(found.map((entry) => entry.type)).toEqual(Array(3).fill('wd:Q2620972'));
  for (const [index, entry] of found.entries()) {
    expect(entry.statement.qualifiers).toEqual([
      { ...snak('schema:position', String(index + 1)), property: { id: 'schema:position', data_type: 'string' } },
      { ...snak('rezics:firstPart', String(index * 8 + 1)), property: { id: 'rezics:firstPart', data_type: 'string' } },
      { ...snak('rezics:lastPart', String(index * 8 + 8)), property: { id: 'rezics:lastPart', data_type: 'string' } },
    ]);
  }
});
test("a work's characters filter by story arc and by role", async () => {
  for (const [filter, expected] of [
    [undefined, characters],
    [arcs[0], characters.slice(0, 2)],
    [arcs[1], [characters[0]]],
    [arcs[2], [characters[2]]],
    [role, [characters[0], characters[2]]],
  ] as const) {
    const page = await forward('schema:character', filter ? `&filter=${filter}` : '');
    expect(page.relations.map((entry: any) => entry.target)).toEqual(expected);
    expect(page).not.toHaveProperty('count');
    expect(page.next).toBeNull();
  }
});
test('a story arc is a subject that links back to its work', async () => {
  for (const arc of arcs) {
    const subject = await call('GET', `/v1/subjects/${arc}`);
    expect(subject.subject.type).toBe('wd:Q2620972');
    const page = await call('GET', `/v1/subjects/${arc}/links?property=rezics%3AstoryArc`);
    expect(page.links.map((link: any) => ({ subject: link.subject, type: link.type, label: link.label }))).toEqual([
      { subject: work, type: 'schema:TVSeries', label: 'A 24-episode series' },
    ]);
    expect(page).not.toHaveProperty('count');
    expect(page.next).toBeNull();
  }
});
test('a relation filter admits two qualifiers', async () => {
  const actor = await create('schema:Person', 'Voice actor');
  const creditWork = await create('schema:TVSeries', 'Credited work', {
    'wdt:P725': [
      statement('wdt:P725', actor, [
        snak('wdt:P3831', role),
        snak('wdt:P518', arcs[0]),
        snak('wdt:P453', characters[0]),
      ]),
    ],
  });
  await catchUp();
  for (const filter of [undefined, role, arcs[0]]) {
    const query = filter ? `&filter=${filter}` : '';
    const page = await call('GET', `/v1/subjects/${creditWork}/relations?property=wdt%3AP725${query}`);
    expect(page.relations.map((entry: any) => entry.target)).toEqual([actor]);
    expect(page).not.toHaveProperty('count');
    const inverse = await call('GET', `/v1/subjects/${actor}/links?property=wdt%3AP725${query}`);
    expect(inverse.links.map((link: any) => link.subject)).toEqual([creditWork]);
    expect(inverse).not.toHaveProperty('count');
  }
});
