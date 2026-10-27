import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type DataType, type Release } from '@rezics/definitions';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { listSubjectGraph } from '../../src/semantic/graph.ts';
import { slotId } from '../../src/semantic/slots.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { startRelays } from '../../src/events/relays.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { createRealAccess } from './real-access.ts';
import { capture, checkGrowth, openGrowthDatabase, type Capture, type GrowthDatabase } from '../support/growth.ts';
import {
  assertUnforcedIndexes,
  logGrowthSeeding,
  seedSemanticPopulation,
  unrelatedSemanticPopulation,
} from './planner-graph-fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const editor = newId(31_000);
const access = await createRealAccess(admin, { editor }, [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
]);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(71)]]) };
const routeKey = new Uint8Array(32).fill(72);
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  tokens: ring,
  routeKey,
  requestDeadlineMs: 30_000,
});
const projection = linkProjection(pool);
const relays = startRelays(pool, [projection], { intervalMs: 50 });
const editorActor: AccountActor = {
  kind: 'account',
  accountId: editor,
  clientId: 'graph-read-test',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const property = (id: string, datatype: DataType, extra: Record<string, unknown> = {}) => ({
  iri: id.startsWith('schema:')
    ? `http://schema.org/${id.slice('schema:'.length)}`
    : `https://example.test/${id.slice(3)}`,
  labels: { en: id },
  mappings: [],
  datatype,
  multivalued: true,
  qualifiers: [],
  value: valueSchema(datatype),
  ...extra,
});
const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/graph-read', version: '1' },
  generator: { name: 'semantic-test', version: '1' },
  prefixes: { ex: 'https://example.test/', schema: 'http://schema.org/' },
  types: {
    'ex:Work': {
      iri: 'https://example.test/Work',
      labels: { en: 'Work' },
      mappings: [],
      bases: [],
      facets: [],
      properties: ['ex:basedOn', 'ex:follows', 'schema:inLanguage'],
    },
    'ex:Character': {
      iri: 'https://example.test/Character',
      labels: { en: 'Character' },
      mappings: [],
      bases: [],
      facets: [],
      properties: ['ex:knows', 'schema:inLanguage'],
    },
  },
  properties: {
    'ex:follows': property('ex:follows', 'wikibase-item', {
      targets: ['ex:Work'],
      relation: { group: 'association', inverse: 'none', order: 'name' },
    }),
    'ex:basedOn': property('ex:basedOn', 'wikibase-item', {
      targets: ['ex:Work'],
      relation: { group: 'derivation', inverse: 'none', order: 'name' },
    }),
    'ex:knows': property('ex:knows', 'wikibase-item', {
      targets: ['ex:Character'],
      relation: { group: 'association', inverse: 'none', order: 'name' },
    }),
    'schema:inLanguage': property('schema:inLanguage', 'string'),
  },
};
const digest = releaseDigest(release);
let growth: GrowthDatabase;
const coveringCaptures: { scale: number; raw: Capture }[] = [];
let growthAnchor = '';
let growthTarget = '';
const createdIds = new Set<string>();
const sessions: Record<string, string> = {};

function statement(propertyId: string, content: string) {
  return { property: { id: propertyId }, value: { type: 'value', content } };
}

async function request(method: string, path: string, options: { body?: unknown; language?: string } = {}) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        ...(sessions.editor ? { 'rezics-session-token': sessions.editor } : {}),
        ...(options.language ? { 'accept-language': options.language } : {}),
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const session = response.headers.get('rezics-session-token');
  if (session) sessions.editor = session;
  return { response, body: (await response.json()) as any };
}

async function call(method: string, path: string, body?: unknown) {
  const result = await request(method, path, { ...(body === undefined ? {} : { body }) });
  if (result.response.status !== 200 && result.response.status !== 201)
    throw new Error(`${method} ${path}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function create(
  type: string,
  label: string,
  options: { follows?: string[]; basedOn?: string[]; knows?: string[] } = {},
) {
  const statements: Record<string, unknown[]> = {};
  if (options.follows) statements['ex:follows'] = options.follows.map((id) => statement('ex:follows', id));
  if (options.basedOn) statements['ex:basedOn'] = options.basedOn.map((id) => statement('ex:basedOn', id));
  if (options.knows) statements['ex:knows'] = options.knows.map((id) => statement('ex:knows', id));
  statements['schema:inLanguage'] = [statement('schema:inLanguage', 'ja')];
  const result = await call('POST', '/v1/subjects', {
    type,
    labels: { en: label, ja: `日本語 ${label}` },
    statements,
  });
  createdIds.add(result.subject.id);
  return result.subject as { id: string; type: string; statements: Record<string, { id: string }[]> };
}

function graphPath(id: string, properties: readonly string[], direction: string, depth: number, limit = 12) {
  const query = new URLSearchParams();
  for (const item of properties) query.append('property', item);
  query.set('direction', direction);
  query.set('depth', String(depth));
  query.set('limit', String(limit));
  return `/v1/subjects/${id}/graph?${query}`;
}

async function catchUp(ids: Iterable<string>) {
  for (const partition of new Set([...ids].map((id) => partitionOf(routeOf(id)!)))) {
    for (let step = 0; step < 2_000; step++) {
      const result = await projection.run(partition);
      if (result.status === 'busy') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (result.envelopes === 0) break;
      if (step === 1_999) throw new Error('Semantic link projection did not catch up');
    }
  }
}

beforeAll(async () => {
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'definitions:publish');
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'definitions:activate');
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  const published = await call('POST', '/v1/definitions/releases', { release });
  await call('POST', `/v1/definitions/releases/${published.digest}:activate`, { expected_head: null });

  growth = await openGrowthDatabase(databaseUrl);
  const actorRelease = { digest, release };
  const actor = { ...editorActor, clientId: 'graph-growth' };
  const route = 51_200;
  growthAnchor = newId(route);
  growthTarget = newId(route + 1);
  for (const [id, at, label] of [
    [growthAnchor, route, 'Growth anchor'],
    [growthTarget, route + 1, 'Growth target'],
  ] as const) {
    await createSubject(growth.pool, {
      actor,
      target: { route: at, id },
      idempotencyKey: randomUUID(),
      digest: new Uint8Array(32).fill(73),
      item: { type: 'ex:Work', labels: { en: label } },
      release: actorRelease,
      authorize: async () => true,
    });
  }
});

afterAll(async () => {
  await relays.stop();
  await Promise.allSettled([growth?.close(), pool.end(), admin.end()]);
});

test('a graph read returns the anchored neighbourhood for explicit properties to depth two', async () => {
  const workD = await create('ex:Work', 'Work D');
  const workC = await create('ex:Work', 'Work C', { follows: [workD.id], basedOn: [workD.id] });
  const workB = await create('ex:Work', 'Work B', { follows: [workC.id], basedOn: [workD.id] });
  const workA = await create('ex:Work', 'Work A', {
    follows: [workB.id, workC.id, workD.id],
    basedOn: [workD.id],
  });
  const workE = await create('ex:Work', 'Work E', { basedOn: [workA.id] });
  const workF = await create('ex:Work', 'Work F', { basedOn: [workA.id] });
  const characterD = await create('ex:Character', 'Character D');
  const characterA = await create('ex:Character', 'Character A', { knows: [characterD.id] });
  const characterB = await create('ex:Character', 'Character B', { knows: [characterA.id] });
  const characterC = await create('ex:Character', 'Character C', { knows: [characterA.id, characterD.id] });
  await catchUp(createdIds);

  const directWorks = await request('GET', graphPath(workA.id, ['ex:follows', 'ex:basedOn'], 'both', 1));
  expect(directWorks.response.status).toBe(200);
  expect(directWorks.body.edges).toEqual(
    expect.arrayContaining([
      { from: workA.id, property: 'ex:follows', to: workB.id, statement: expect.any(String) },
      { from: workA.id, property: 'ex:follows', to: workC.id, statement: expect.any(String) },
      { from: workA.id, property: 'ex:follows', to: workD.id, statement: expect.any(String) },
      { from: workE.id, property: 'ex:basedOn', to: workA.id, statement: expect.any(String) },
      { from: workF.id, property: 'ex:basedOn', to: workA.id, statement: expect.any(String) },
    ]),
  );

  const works = await request('GET', graphPath(workA.id, ['ex:follows', 'ex:basedOn'], 'both', 2, 1), {
    language: 'ja, en;q=0.5',
  });
  expect(works.response.status).toBe(200);
  expect(works.body.nodes[0]).toEqual({
    id: workA.id,
    type: 'ex:Work',
    label: '日本語 Work A',
    summary: {
      id: workA.id,
      type: 'ex:Work',
      types: ['ex:Work'],
      label: { value: '日本語 Work A', language: 'ja' },
      creativeWork: false,
      cover: null,
    },
  });
  expect(works.body.nodes.map((node: { id: string }) => node.id)).toEqual(
    expect.arrayContaining([workA.id, workB.id, workC.id, workD.id, workE.id]),
  );
  expect(new Set(works.body.nodes.map((node: { id: string }) => node.id)).size).toBe(works.body.nodes.length);
  expect(new Set(works.body.edges.map((edge: unknown) => JSON.stringify(edge))).size).toBe(works.body.edges.length);
  expect(works.body.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: workA.id, property: 'ex:follows', to: workB.id }),
      expect.objectContaining({ from: workB.id, property: 'ex:follows', to: workC.id }),
      expect.objectContaining({ from: workE.id, property: 'ex:basedOn', to: workA.id }),
    ]),
  );

  const forward = works.body.truncated.find(
    (entry: { node: string; property: string; direction: string }) =>
      entry.node === workA.id && entry.property === 'ex:follows' && entry.direction === 'out',
  );
  expect(forward).toMatchObject({ count: 3 });
  const forwardPage = await request(
    'GET',
    `/v1/subjects/${workA.id}/relations?property=ex%3Afollows&cursor=${encodeURIComponent(forward.cursor)}`,
    { language: 'ja, en;q=0.5' },
  );
  expect(forwardPage.response.status).toBe(200);
  const firstFollowTarget = works.body.edges.find(
    (edge: { from: string; property: string }) => edge.from === workA.id && edge.property === 'ex:follows',
  ).to;
  const continuedTargets = forwardPage.body.relations.map((entry: { target: string }) => entry.target);
  expect(new Set(continuedTargets)).toEqual(
    new Set([workB.id, workC.id, workD.id].filter((id) => id !== firstFollowTarget)),
  );

  const inverse = works.body.truncated.find(
    (entry: { node: string; property: string; direction: string }) =>
      entry.node === workA.id && entry.property === 'ex:basedOn' && entry.direction === 'in',
  );
  expect(inverse).toMatchObject({ count: 2 });
  const inversePage = await request(
    'GET',
    `/v1/subjects/${workA.id}/links?property=ex%3AbasedOn&cursor=${encodeURIComponent(inverse.cursor)}`,
    { language: 'ja, en;q=0.5' },
  );
  expect(inversePage.response.status).toBe(200);
  const firstBasedOnSource = works.body.edges.find(
    (edge: { to: string; property: string }) => edge.to === workA.id && edge.property === 'ex:basedOn',
  ).from;
  expect(inversePage.body.links.map((entry: { subject: string }) => entry.subject)).toEqual(
    [workE.id, workF.id].filter((id) => id !== firstBasedOnSource),
  );

  const characters = await request('GET', graphPath(characterA.id, ['ex:knows'], 'both', 2), {
    language: 'ja, en;q=0.5',
  });
  expect(characters.response.status).toBe(200);
  expect(characters.body.nodes.map((node: { id: string }) => node.id)).toEqual(
    expect.arrayContaining([characterA.id, characterB.id, characterC.id, characterD.id]),
  );
  expect(new Set(characters.body.nodes.map((node: { id: string }) => node.id)).size).toBe(characters.body.nodes.length);
  expect(characters.body.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: characterA.id, property: 'ex:knows', to: characterD.id }),
      expect.objectContaining({ from: characterB.id, property: 'ex:knows', to: characterA.id }),
      expect.objectContaining({ from: characterC.id, property: 'ex:knows', to: characterA.id }),
    ]),
  );

  const directCharacters = await request('GET', graphPath(characterA.id, ['ex:knows'], 'both', 1));
  expect(directCharacters.response.status).toBe(200);
  expect(directCharacters.body.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: characterA.id, property: 'ex:knows', to: characterD.id }),
      expect.objectContaining({ from: characterB.id, property: 'ex:knows', to: characterA.id }),
      expect.objectContaining({ from: characterC.id, property: 'ex:knows', to: characterA.id }),
    ]),
  );
});

test('a graph read refuses unanchored or unbounded requests', async () => {
  const subject = await create('ex:Work', 'Refusal work');
  await catchUp(createdIds);
  const noAnchor = await request('GET', '/v1/subjects/graph?property=ex%3Afollows&direction=out&depth=1');
  expect(noAnchor.response.status).toBe(400);
  expect(noAnchor.body.errors).toContainEqual({ pointer: '/id', code: 'required' });

  const invalidAnchor = await request(
    'GET',
    '/v1/subjects/not-a-subject-id/graph?property=ex%3Afollows&direction=out&depth=1',
  );
  expect(invalidAnchor.response.status).toBe(400);
  expect(invalidAnchor.body.errors).toContainEqual({ pointer: '/id', code: 'invalid_format' });

  const noProperty = await request('GET', `/v1/subjects/${subject.id}/graph?direction=out&depth=1`);
  expect(noProperty.response.status).toBe(400);
  expect(noProperty.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/property' })]));

  const deep = await request('GET', `/v1/subjects/${subject.id}/graph?property=ex%3Afollows&direction=out&depth=3`);
  expect(deep.response.status).toBe(400);
  expect(deep.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/depth' })]));

  const wide = await request(
    'GET',
    `/v1/subjects/${subject.id}/graph?property=ex%3Afollows&direction=out&depth=1&limit=26`,
  );
  expect(wide.response.status).toBe(400);
  expect(wide.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '/limit' })]));

  const tooMany = new URLSearchParams();
  for (let index = 0; index < 9; index++) tooMany.append('property', 'ex:follows');
  tooMany.set('direction', 'out');
  tooMany.set('depth', '1');
  const manyProperties = await request('GET', `/v1/subjects/${subject.id}/graph?${tooMany}`);
  expect(manyProperties.response.status).toBe(400);
  expect(manyProperties.body.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ pointer: '/property' })]),
  );
});

test('a graph read costs the same whatever the size of the graph beyond its bounds', async () => {
  const anchorRoute = routeOf(growthAnchor)!;
  const targetRoute = routeOf(growthTarget)!;
  const unrelated = unrelatedSemanticPopulation('graph-read-unrelated', partitionOf(anchorRoute));
  const operation = async () => {
    const graph = await listSubjectGraph(growth.pool, ring, {
      subject: growthAnchor,
      properties: ['ex:follows'],
      direction: 'out',
      depth: 2,
      limit: 12,
      languages: ['en'],
      release,
      authorizeSummary: async () => true,
      authorize: async () => true,
    });
    expect(graph.edges).toHaveLength(12);
    expect(graph.truncated).toEqual([
      expect.objectContaining({
        node: growthAnchor,
        property: 'ex:follows',
        direction: 'out',
        count: expect.any(Number),
      }),
    ]);
    expect(graph.nodes).toContainEqual({
      id: growthTarget,
      type: 'ex:Work',
      label: 'Growth target',
      summary: {
        id: growthTarget,
        type: 'ex:Work',
        types: ['ex:Work'],
        label: { value: 'Growth target', language: 'en' },
        creativeWork: false,
        cover: null,
      },
    });
    expect(partitionOf(targetRoute)).toBe(partitionOf(anchorRoute));
  };
  const report = await checkGrowth(growth, {
    name: 'a graph read costs the same whatever the size of the graph beyond its bounds',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database: GrowthDatabase, scale: number, previous: number) => {
      if (scale > previous)
        await growth.admin.query(
          `INSERT INTO semantic.outbound_link(
             route,subject_id,property,filter_value,order_key,target_subject_id,statement_id,slot_id,
             relation,source_type,source_order_key,outbound_order,source_revision,source_security_revision,
             target_revision,target_type,external,value,present,recorded_transaction_id
           )
           SELECT $1,$2,'ex:follows','00000000-0000-0000-0000-000000000000',lpad(n::text,8,'0'),$3,
                  md5(n::text)::uuid,$4,true,'ex:Work','','name',1,0,1,'ex:Work',NULL,'value',true,gen_random_uuid()
           FROM generate_series($5::integer + 1,$6::integer) AS n`,
          [anchorRoute, growthAnchor, growthTarget, slotId(growthAnchor, 'ex:follows'), previous, scale],
        );
      await growth.admin.query(
        `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
         VALUES ($1,$2,'ex:follows','00000000-0000-0000-0000-000000000000',$3)
         ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
        [anchorRoute, growthAnchor, scale],
      );
      await seedSemanticPopulation({ pool: growth.pool, admin: growth.admin }, unrelated.population, {
        from: previous * 500,
        to: scale * 500,
      });
    },
    operation,
    warmup: async (_database, scale) => {
      const measured = await capture(growth, operation);
      coveringCaptures.push({ scale, raw: measured.capture });
    },
  });
  logGrowthSeeding(report);
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.statements > 0)).toBe(true);
}, 900_000);

test('graph and summary covering reads use unforced indexed access as their populations grow', () => {
  const failures: unknown[] = [];
  for (const { scale, raw } of coveringCaptures) {
    try {
      assertUnforcedIndexes('bounded graph expansion and node summaries', scale, raw, {
        'semantic.subject': 'subject_pkey',
        'semantic.fact': ['fact_label', 'fact_terms'],
        'semantic.outbound_link': 'outbound_link_maintenance',
        'semantic.inbound_link': 'inbound_link_present',
        'semantic.outbound_link_count': 'outbound_link_count_pkey',
      });
    } catch (error) {
      failures.push(error);
    }
  }
  expect(coveringCaptures.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(failures).toEqual([]);
});
