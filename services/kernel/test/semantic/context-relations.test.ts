import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection, listSubjectLinks, listSubjectRelations } from '../../src/semantic/links.ts';
import { createRealAccess } from './real-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const editor = newId(30_000);
const actions = [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
  'subject:merge',
  'moderation:hide',
  'moderation:takedown',
];
const access = await createRealAccess(admin, { editor }, actions);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(49)]]) };
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  routeKey: new Uint8Array(32).fill(48),
  tokens: ring,
});
const projection = linkProjection(pool);
const itemProperty = (id: string, group: 'appearance' | 'credit') => ({
  iri: `https://example.test/${id.slice(3)}`,
  labels: { en: id },
  mappings: [],
  datatype: 'wikibase-item' as const,
  multivalued: true,
  qualifiers: ['schema:position'],
  value: valueSchema('wikibase-item'),
  targets: ['ex:Person'],
  relation: { inverse: 'none' as const, group, order: 'position' as const },
});
const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/context-relations', version: '1' },
  generator: { name: 'semantic-test', version: '1' },
  prefixes: { ex: 'https://example.test/', schema: 'http://schema.org/' },
  types: Object.fromEntries(
    ['Work', 'Person'].map((name) => [
      `ex:${name}`,
      {
        iri: `https://example.test/${name}`,
        labels: { en: name },
        mappings: [],
        bases: [],
        facets: [],
        properties: ['ex:appearance', 'ex:credit', 'ex:elsewhere', 'schema:position'],
      },
    ]),
  ),
  properties: {
    'ex:appearance': itemProperty('ex:appearance', 'appearance'),
    'ex:credit': itemProperty('ex:credit', 'credit'),
    'ex:elsewhere': itemProperty('ex:elsewhere', 'appearance'),
    'schema:url': {
      iri: 'http://schema.org/url',
      labels: { en: 'URL' },
      mappings: [],
      datatype: 'url',
      multivalued: true,
      qualifiers: [],
      value: valueSchema('url'),
    },
    'schema:position': {
      iri: 'http://schema.org/position',
      labels: { en: 'Position' },
      mappings: [],
      datatype: 'quantity',
      units: ['1'],
      multivalued: false,
      qualifiers: [],
      value: valueSchema('quantity', { units: ['1'], integer: true }),
    },
  },
};
const digest = releaseDigest(release);
const statement = (property: string, target: string, position: number) => ({
  property: { id: property },
  value: { type: 'value', content: target },
  qualifiers: [
    {
      property: { id: 'schema:position' },
      value: { type: 'value', content: { amount: `+${position}`, unit: '1' } },
    },
  ],
  references: [],
});
async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        'accept-language': 'fr, ja;q=0.9, en;q=0.5',
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
let context: string;
let work: string;
let people: string[];
let appearance: string;
let oldCredit: string;
let newAppearance: string;
let newCredit: string;
let growth: GrowthDatabase;
const partitions = new Set<number>();
async function drain() {
  for (let step = 0; step < 100; step++) {
    let pending = false;
    for (const partition of partitions) {
      const result = await projection.run(partition);
      pending ||= result.status === 'busy' || result.envelopes > 0;
    }
    if (!pending) return;
  }
  throw new Error('Links relay did not drain');
}
async function adopt(
  property: string,
  candidate: string,
  target: string,
  mode = 'replace',
  head: number | null = null,
) {
  return call('POST', `/v1/subjects/${work}:adopt`, {
    context,
    property,
    target,
    mode,
    expected_head: head,
    selection: mode === 'replace' ? [{ candidate, rank: 'normal' }] : [],
  });
}
const forward = (property: string, local = true) =>
  call('GET', `/v1/subjects/${work}/relations?property=${property}${local ? `&context=${context}` : ''}&limit=1`);
const inverse = (target: string, property: string, local = true) =>
  call('GET', `/v1/subjects/${target}/links?property=${property}${local ? `&context=${context}` : ''}&limit=1`);

beforeAll(async () => {
  // The integration fixture performs more writes than a new account's minute budget.
  await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const published = await call('POST', '/v1/definitions/releases', { release });
  expect(published.digest).toBe(digest);
  await call('POST', `/v1/definitions/releases/${digest}:activate`, { expected_head: null });
  context = (await call('POST', '/v1/contexts', { labels: { en: 'Realm' } })).context.id;
  people = [];
  for (let index = 0; index < 3; index++) {
    const id = (
      await call('POST', '/v1/subjects', { type: 'ex:Person', labels: { en: `Person ${index}`, ja: `人物${index}` } })
    ).subject.id;
    people.push(id);
    partitions.add(partitionOf(routeOf(id)!));
    await access.grant({ route: routeOf(id)!, id }, 'editor', 'subject:read');
  }
  const created = await call('POST', '/v1/subjects', {
    type: 'ex:Work',
    labels: { en: 'Work' },
    statements: {
      'ex:appearance': [statement('ex:appearance', people[0]!, 1)],
      'ex:credit': [statement('ex:credit', people[1]!, 1)],
    },
  });
  work = created.subject.id;
  partitions.add(partitionOf(routeOf(work)!));
  await access.grant({ route: routeOf(work)!, id: work }, 'editor', 'subject:read');
  appearance = created.subject.statements['ex:appearance'][0].id;
  oldCredit = created.subject.statements['ex:credit'][0].id;
  async function propose(property: string, target: string, position: number) {
    const result = await call('POST', `/v1/subjects/${work}/candidates`, {
      statement: {
        ...statement(property, target, position),
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } },
            ],
          },
        ],
      },
    });
    const candidate = result.candidate;
    await call('POST', `/v1/subjects/${work}/candidates/${candidate}:accept`, { context, expected_head: null });
    return candidate;
  }
  newAppearance = await propose('ex:appearance', people[2]!, 2);
  newCredit = await propose('ex:credit', people[1]!, 2);
  await adopt('ex:appearance', newAppearance, people[2]!);
  await adopt('ex:appearance', appearance, people[0]!, 'suppress');
  await adopt('ex:credit', newCredit, people[1]!);
  await drain();
  growth = await openGrowthDatabase(url);
}, 30_000);
afterAll(async () => {
  await growth?.close();
  await pool.end();
  await admin.end();
});

test("a community Context's relation pages show its accepted, replaced and suppressed relations over Global's", async () => {
  const appearances = await forward('ex:appearance');
  expect(appearances.relations.map((row: any) => [row.statement.id, row.target, row.label])).toEqual([
    [newAppearance, people[2], '人物2'],
  ]);
  expect(appearances.next).toBeNull();
  const credits = await forward('ex:credit');
  expect(credits.relations.map((row: any) => row.statement.id)).toEqual([newCredit]);
  expect((await inverse(people[0]!, 'ex:appearance')).links).toEqual([]);
  expect((await inverse(people[2]!, 'ex:appearance')).links.map((row: any) => row.statement)).toEqual([newAppearance]);
  expect((await inverse(people[1]!, 'ex:credit')).links.map((row: any) => row.statement)).toEqual([newCredit]);
  const preview = (await call('GET', `/v1/subjects/${work}?context=${context}`)).subject;
  expect(preview.statements['ex:appearance'].map((row: any) => row.id)).toEqual([newAppearance]);
  expect(preview.statements['ex:credit'].map((row: any) => row.id)).toEqual([newCredit]);
  expect(preview.resolution).toEqual({ 'ex:appearance': 'suppressed' });
});

test("a Context's relation counts are exact", async () => {
  for (const property of ['ex:appearance', 'ex:credit'])
    expect((await forward(property)).count).toEqual({ value: 1, exact: true });
  expect((await inverse(people[0]!, 'ex:appearance')).count).toEqual({ value: 0, exact: true });
  expect((await inverse(people[2]!, 'ex:appearance')).count).toEqual({ value: 1, exact: true });
  expect((await inverse(people[1]!, 'ex:credit')).count).toEqual({ value: 1, exact: true });
  const preview = (await call('GET', `/v1/subjects/${work}?context=${context}`)).subject;
  expect(preview.relationCounts).toEqual({ 'ex:appearance': 1, 'ex:credit': 1, 'ex:elsewhere': 0 });
});

test("Global pages never show a community Context's relation changes", async () => {
  expect((await forward('ex:appearance', false)).relations.map((row: any) => row.statement.id)).toEqual([appearance]);
  expect((await forward('ex:credit', false)).relations.map((row: any) => row.statement.id)).toEqual([oldCredit]);
  expect((await inverse(people[0]!, 'ex:appearance', false)).count).toEqual({ value: 1, exact: true });
  expect((await inverse(people[2]!, 'ex:appearance', false)).links).toEqual([]);
  expect((await inverse(people[1]!, 'ex:credit', false)).links.map((row: any) => row.statement)).toEqual([oldCredit]);
  const preview = (await call('GET', `/v1/subjects/${work}`)).subject;
  expect(preview.statements['ex:appearance'].map((row: any) => row.id)).toEqual([appearance]);
  expect(preview.statements['ex:credit'].map((row: any) => row.id)).toEqual([oldCredit]);
});

test("a Context relation page examines rows bounded by the page and the Context's own changes in its range", async () => {
  for (const direction of ['outbound', 'inbound'] as const) {
    const report = await checkGrowth(growth, {
      name: `Context ${direction} relation page`,
      scales: [16, 128, 1024],
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      async grow(db, scale, previous) {
        // Other properties of the very same subject and Context must never enter the page's scan.
        if (direction === 'outbound')
          await db.admin.query(
            `
          INSERT INTO semantic.outbound_link(route,subject_id,context_id,property,filter_value,order_key,target_subject_id,
            statement_id,slot_id,relation,source_revision,present,suppressed,recorded_transaction_id,value)
          SELECT $1,$2,$3,'ex:elsewhere','00000000-0000-0000-0000-000000000000',lpad(n::text,8,'0'),$4,
            gen_random_uuid(),gen_random_uuid(),true,1,true,n % 2 = 0,gen_random_uuid(),'value'
          FROM generate_series($5::int,$6::int) n`,
            [routeOf(work), work, context, people[1], previous + 1, scale],
          );
        else
          await db.admin.query(
            `
          INSERT INTO semantic.inbound_link(route,subject_id,context_id,property,source_subject_id,statement_id,
            source_revision,present,suppressed,recorded_transaction_id)
          SELECT $1,$2,$3,'ex:elsewhere',$4,gen_random_uuid(),1,true,n % 2 = 0,gen_random_uuid()
          FROM generate_series($5::int,$6::int) n`,
            [routeOf(people[1]!), people[1], context, work, previous + 1, scale],
          );
      },
      async operation(db) {
        if (direction === 'outbound') {
          const page = await listSubjectRelations(db.pool, ring, {
            routeKey: new Uint8Array(32).fill(48),
            subject: work,
            property: 'ex:credit',
            context,
            limit: 1,
            release,
            seen: [],
            caughtUp: true,
            authorize: async () => true,
          });
          expect(page.relations.map((row) => row.statement.id)).toEqual([newCredit]);
        } else {
          const page = await listSubjectLinks(db.pool, ring, {
            routeKey: new Uint8Array(32).fill(48),
            subject: people[1]!,
            property: 'ex:credit',
            context,
            limit: 1,
            seen: [],
            caughtUp: true,
            includeLabels: false,
            authorize: async () => true,
          });
          expect(page.links.map((row) => row.statement)).toEqual([newCredit]);
        }
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([16, 128, 1024]);
  }
  // Growth-only projection rows have no candidates or relay counters.
  await admin.query(
    "DELETE FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2 AND context_id=$3 AND property='ex:elsewhere'",
    [routeOf(work), work, context],
  );
  await admin.query(
    "DELETE FROM semantic.inbound_link WHERE route=$1 AND subject_id=$2 AND context_id=$3 AND property='ex:elsewhere'",
    [routeOf(people[1]!), people[1], context],
  );
}, 60_000);

test('Context paging and inheritance remain correct when Global adopts a local relation', async () => {
  const subject = (
    await call('POST', '/v1/subjects', {
      type: 'ex:Work',
      labels: { en: 'Mixed page' },
      statements: {
        'ex:appearance': [statement('ex:appearance', people[0]!, 1), statement('ex:appearance', people[1]!, 3)],
      },
    })
  ).subject.id;
  partitions.add(partitionOf(routeOf(subject)!));
  await access.grant({ route: routeOf(subject)!, id: subject }, 'editor', 'subject:read');
  const candidate = (
    await call('POST', `/v1/subjects/${subject}/candidates`, {
      statement: {
        ...statement('ex:appearance', people[2]!, 2),
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } },
            ],
          },
        ],
      },
    })
  ).candidate;
  const decide = (selectedContext: string) =>
    call('POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, {
      context: selectedContext,
      expected_head: null,
    });
  const select = (selectedContext: string, target: string, mode: string, head: number | null = null) =>
    call('POST', `/v1/subjects/${subject}:adopt`, {
      context: selectedContext,
      property: 'ex:appearance',
      target,
      mode,
      expected_head: head,
      selection: mode === 'replace' ? [{ candidate, rank: 'normal' }] : [],
    });
  await decide(context);
  const local = await select(context, people[2]!, 'replace');
  const suppressed = await select(context, people[0]!, 'suppress');
  await drain();
  const path = `/v1/subjects/${subject}/relations?property=ex:appearance&context=${context}&limit=1`;
  const first = await call('GET', path);
  expect(first.relations.map((row: any) => row.target)).toEqual([people[2]]);
  expect(first.count).toEqual({ value: 2, exact: true });
  expect(typeof first.next).toBe('string');
  const second = await call('GET', `${path}&cursor=${encodeURIComponent(first.next)}`);
  expect(second.relations.map((row: any) => row.target)).toEqual([people[1]]);
  expect(second.next).toBeNull();
  await decide(GLOBAL_CONTEXT);
  await select(GLOBAL_CONTEXT, people[2]!, 'replace');
  await drain();
  expect((await call('GET', path)).count).toEqual({ value: 2, exact: true });
  await select(context, people[2]!, 'inherit', local.adoption.head);
  await select(context, people[0]!, 'inherit', suppressed.adoption.head);
  await drain();
  const inherited = await call('GET', path.replace('&limit=1', '&limit=10'));
  expect(inherited.relations.map((row: any) => row.target)).toEqual([people[0], people[2], people[1]]);
  expect(inherited.count).toEqual({ value: 3, exact: true });
}, 60_000);

test('Context rows survive holder visibility changes and target redirects', async () => {
  const previous = (await inverse(people[2]!, 'ex:appearance')).count.value;
  await call('POST', `/v1/subjects/${work}:hide`, { reason: 'Projection test' });
  await drain();
  expect((await inverse(people[2]!, 'ex:appearance')).count).toEqual({ value: previous - 1, exact: true });
  await call('POST', `/v1/subjects/${work}:restore`, { reason: 'Projection test' });
  await drain();
  expect((await forward('ex:appearance')).relations.map((row: any) => row.statement.id)).toEqual([newAppearance]);
  expect((await inverse(people[2]!, 'ex:appearance')).count).toEqual({ value: previous, exact: true });
  await call('POST', `/v1/subjects/${work}/candidates/${newCredit}:hide`, { reason: 'Projection test' });
  await drain();
  expect((await inverse(people[1]!, 'ex:credit')).count).toEqual({ value: 0, exact: true });
  expect((await forward('ex:credit')).count).toEqual({ value: 0, exact: true });
  await call('POST', `/v1/subjects/${work}/candidates/${newCredit}:restore`, { reason: 'Projection test' });
  await drain();
  expect((await forward('ex:credit')).relations.map((row: any) => row.statement.id)).toEqual([newCredit]);
  const merged = await call('POST', '/v1/subjects:merge', { subjects: [people[0], people[2]] });
  await drain();
  expect(
    (
      await call('GET', `/v1/subjects/${merged.survivor}/links?property=ex:appearance&context=${context}&limit=100`)
    ).links
      .filter((row: any) => row.subject === work)
      .map((row: any) => row.statement),
  ).toEqual([newAppearance]);
  expect((await forward('ex:appearance')).relations.map((row: any) => row.statement.id)).toEqual([newAppearance]);
}, 60_000);

test('a Context preview includes each projected statement once when a slot selects several values', async () => {
  const subject = (await call('POST', '/v1/subjects', { type: 'ex:Work', labels: { en: 'Several selected values' } }))
    .subject.id;
  partitions.add(partitionOf(routeOf(subject)!));
  await access.grant({ route: routeOf(subject)!, id: subject }, 'editor', 'subject:read');
  const selected: string[] = [];
  for (const position of [1, 2]) {
    const candidate = (
      await call('POST', `/v1/subjects/${subject}/candidates`, {
        statement: {
          ...statement('ex:appearance', people[1]!, position),
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } },
              ],
            },
          ],
        },
      })
    ).candidate;
    await call('POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, { context, expected_head: null });
    selected.push(candidate);
  }
  await call('POST', `/v1/subjects/${subject}:adopt`, {
    context,
    property: 'ex:appearance',
    target: people[1],
    mode: 'replace',
    expected_head: null,
    selection: selected.map((candidate) => ({ candidate, rank: 'normal' })),
  });
  await drain();
  const page = await call('GET', `/v1/subjects/${subject}/relations?property=ex:appearance&context=${context}`);
  expect(page.relations.map((row: any) => row.statement.id)).toEqual(selected);
  expect(page.count).toEqual({ value: 2, exact: true });
  const preview = (await call('GET', `/v1/subjects/${subject}?context=${context}`)).subject;
  expect(preview.statements['ex:appearance'].map((row: any) => row.id)).toEqual(selected);
  expect(preview.relationCounts).toEqual({ 'ex:appearance': 2, 'ex:credit': 0, 'ex:elsewhere': 0 });
}, 60_000);
