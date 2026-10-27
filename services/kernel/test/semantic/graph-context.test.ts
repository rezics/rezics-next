import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { valueSchema, type Release } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const editor = newId(30_001);
const actions = [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
];
const access = await createRealAccess(admin, { editor }, actions);
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  routeKey: new Uint8Array(32).fill(81),
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
});
const projection = linkProjection(pool);
const properties = ['ex:basedOn', 'ex:follows'];
const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/graph-context', version: '1' },
  generator: { name: 'semantic-test', version: '1' },
  prefixes: { ex: 'https://example.test/', schema: 'http://schema.org/' },
  types: {
    'ex:Work': {
      iri: 'https://example.test/Work',
      labels: { en: 'Work' },
      mappings: [],
      bases: [],
      facets: [],
      properties,
    },
  },
  properties: {
    ...Object.fromEntries(
      properties.map((id) => [
        id,
        {
          iri: `https://example.test/${id.slice(3)}`,
          labels: { en: id },
          mappings: [],
          datatype: 'wikibase-item' as const,
          multivalued: true,
          qualifiers: [],
          value: valueSchema('wikibase-item'),
          targets: ['ex:Work'],
          relation: { group: 'association' as const, inverse: 'none' as const, order: 'name' as const },
        },
      ]),
    ),
    'schema:url': {
      iri: 'http://schema.org/url',
      labels: { en: 'URL' },
      mappings: [],
      datatype: 'url',
      multivalued: true,
      qualifiers: [],
      value: valueSchema('url'),
    },
  },
};
const partitions = new Set<number>();
const statement = (property: string, target: string) => ({
  property: { id: property },
  value: { type: 'value', content: target },
});
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
async function create(label: string, follows: string[] = [], basedOn: string[] = []) {
  const { subject } = await call('POST', '/v1/subjects', {
    type: 'ex:Work',
    labels: { en: label },
    statements: {
      'ex:follows': follows.map((target) => statement('ex:follows', target)),
      'ex:basedOn': basedOn.map((target) => statement('ex:basedOn', target)),
    },
  });
  partitions.add(partitionOf(routeOf(subject.id)!));
  return subject.id as string;
}
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

beforeAll(async () => {
  await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const published = await call('POST', '/v1/definitions/releases', { release });
  await call('POST', `/v1/definitions/releases/${published.digest}:activate`, { expected_head: null });
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

test('the Global graph excludes community-only forward and inverse relations and counts', async () => {
  const leaf = await create('Global leaf');
  const first = await create('Global first', [leaf]);
  const second = await create('Global second');
  const anchor = await create('Global anchor', [first, second], [first, second]);
  const source = await create('Global source', [anchor]);
  const otherSource = await create('Global other source', [anchor]);
  const ancestor = await create('Global ancestor', [source]);
  const locals = await Promise.all(['Community A', 'Community B', 'Community C'].map((label) => create(label)));
  await drain();

  // Two properties put outbound requests in both the seed and recursive SQL branches;
  // both directions do the same for inbound requests, even in a single-node partition.
  async function snapshot(depth: number, direction: string, limit: number) {
    const query = new URLSearchParams({ depth: String(depth), direction, limit: String(limit) });
    for (const property of properties) query.append('property', property);
    const graph = await call('GET', `/v1/subjects/${anchor}/graph?${query}`);
    const continuations = [];
    for (const entry of graph.truncated) {
      const page = await call(
        'GET',
        `/v1/subjects/${entry.node}/${entry.direction === 'out' ? 'relations' : 'links'}?property=${entry.property}&cursor=${encodeURIComponent(entry.cursor)}`,
      );
      continuations.push({
        node: entry.node,
        property: entry.property,
        direction: entry.direction,
        count: page.count,
        statements: (entry.direction === 'out'
          ? page.relations.map((row: any) => row.statement.id)
          : page.links.map((row: any) => row.statement)
        ).sort(),
        next: page.next,
      });
    }
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      truncated: graph.truncated.map(({ cursor, ...entry }: any) => {
        expect(typeof cursor).toBe('string');
        return entry;
      }),
      continuations,
    };
  }
  const cases = [1, 2].flatMap((depth) =>
    ['out', 'in', 'both'].flatMap((direction) => [1, 12].map((limit) => ({ depth, direction, limit }))),
  );
  const baseline = [];
  for (const { depth, direction, limit } of cases) baseline.push(await snapshot(depth, direction, limit));
  expect(baseline[0]!.truncated).toEqual(
    expect.arrayContaining([expect.objectContaining({ node: anchor, direction: 'out', count: 2 })]),
  );
  expect(baseline[2]!.truncated).toEqual([expect.objectContaining({ node: anchor, direction: 'in', count: 2 })]);
  expect(baseline[7]!.edges).toContainEqual(expect.objectContaining({ from: first, to: leaf }));
  expect(baseline[9]!.edges).toContainEqual(expect.objectContaining({ from: ancestor, to: source }));

  const context = (await call('POST', '/v1/contexts', { labels: { en: 'Community graph' } })).context.id;
  async function adopt(subject: string, property: string, target: string) {
    const { candidate } = await call('POST', `/v1/subjects/${subject}/candidates`, {
      statement: {
        ...statement(property, target),
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } },
            ],
          },
        ],
      },
    });
    await call('POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, { context, expected_head: null });
    await call('POST', `/v1/subjects/${subject}:adopt`, {
      context,
      property,
      target,
      mode: 'replace',
      expected_head: null,
      selection: [{ candidate, rank: 'normal' }],
    });
  }
  for (const target of locals) {
    for (const property of properties) {
      await adopt(anchor, property, target);
      await adopt(target, property, anchor);
    }
  }
  await adopt(first, 'ex:follows', locals[0]!);
  await adopt(locals[0]!, 'ex:follows', source);
  await adopt(second, 'ex:follows', locals[0]!);
  await adopt(locals[0]!, 'ex:follows', second);
  await drain();
  // Assert the production projections exist and the Context pages differ from Global.
  const localOut = await call('GET', `/v1/subjects/${anchor}/relations?property=ex:follows&context=${context}`);
  expect(localOut.count).toEqual({ value: 5, exact: true });
  expect(localOut.relations.map((row: any) => row.target)).toEqual(expect.arrayContaining(locals));
  const localIn = await call('GET', `/v1/subjects/${anchor}/links?property=ex:follows&context=${context}`);
  expect(localIn.count).toEqual({ value: 5, exact: true });
  expect(localIn.links.map((row: any) => row.subject)).toEqual(expect.arrayContaining(locals));
  for (const [index, { depth, direction, limit }] of cases.entries()) {
    expect(await snapshot(depth, direction, limit)).toEqual(baseline[index]!);
  }
  expect(baseline[3]!.nodes.map((node: any) => node.id)).toEqual(expect.arrayContaining([source, otherSource]));
}, 60_000);
