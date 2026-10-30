import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import {
  EXTENSION_FORMAT,
  extensionDigest,
  termPrefix,
  type Extension,
  type TermDefinition,
} from '@rezics/definitions/extension';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { effectiveRelease } from '../../src/semantic/extensions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { readSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const editor = newId(31_000);
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
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(51)]]) };
const kernel = createKernel({
  pool,
  access: access.access,
  writeRate: access.writeRate,
  routeKey: new Uint8Array(32).fill(50),
  tokens: ring,
});
const projection = linkProjection(pool);
const base: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/custom-relation-types', version: '1' },
  generator: { name: 'semantic-test', version: '1' },
  prefixes: { ex: 'https://example.test/', schema: 'http://schema.org/' },
  types: Object.fromEntries(
    ['Character', 'Faction'].map((name) => [
      `ex:${name}`,
      {
        iri: `https://example.test/${name}`,
        labels: { en: name },
        mappings: [],
        bases: [],
        facets: [],
        properties: ['schema:position', 'schema:url'],
      },
    ]),
  ),
  properties: {
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
const baseDigest = releaseDigest(base);

let realm: string;
let prefix: string;
let mentorOf: string;
let studentOf: string;
let rivalOf: string;
const term = (overrides: Partial<TermDefinition> = {}): TermDefinition => ({
  description: { en: 'A relation the Realm defines.' },
  labels: { en: 'related' },
  domain: ['ex:Character'],
  targets: ['ex:Character'],
  multivalued: true,
  qualifiers: ['schema:position'],
  relation: { group: 'world', symmetric: true },
  ...overrides,
});
const extensionOf = (context: string, terms: Record<string, TermDefinition>): Extension => ({
  format: EXTENSION_FORMAT,
  context,
  terms,
});
const realmTerms = (): Record<string, TermDefinition> => ({
  [rivalOf]: term({
    description: { en: 'Two characters who compete with each other.' },
    labels: { en: 'rival of' },
  }),
  [mentorOf]: term({
    description: { en: 'A character who teaches another or a faction.' },
    labels: { en: 'mentor of' },
    targets: ['ex:Character', 'ex:Faction'],
    relation: {
      group: 'association',
      inverse: studentOf,
      inverseLabels: { en: 'student of' },
      acyclic: true,
      order: 'position',
    },
  }),
});

async function send(method: string, path: string, body?: unknown) {
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
  return { status: response.status, body: (await response.json()) as any };
}
async function call(method: string, path: string, body?: unknown) {
  const result = await send(method, path, body);
  if (result.status !== 200 && result.status !== 201)
    throw new Error(`${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
const publish = (context: string, extension: unknown) =>
  send('POST', `/v1/contexts/${context}/definitions/extensions`, { extension });
const activate = (context: string, digest: string, head: number | null) =>
  send('POST', `/v1/contexts/${context}/definitions/extensions/${digest}:activate`, { expected_head: head });
async function install(context: string, extension: Extension, head: number | null) {
  const published = await publish(context, extension);
  expect([200, 201]).toContain(published.status);
  const activated = await activate(context, published.body.digest, head);
  expect(activated.status).toBe(200);
  return activated.body;
}
const grantDefinitions = async (context: string) => {
  for (const action of ['definitions:publish', 'definitions:activate'])
    await access.grant({ route: routeOf(context)!, id: context }, 'editor', action);
};

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
async function character(name: string, type = 'ex:Character') {
  const id = (await call('POST', '/v1/subjects', { type, labels: { en: name } })).subject.id as string;
  partitions.add(partitionOf(routeOf(id)!));
  await access.grant({ route: routeOf(id)!, id }, 'editor', 'subject:read');
  return id;
}
async function state(holder: string, property: string, target: string, position: number, context: string) {
  const candidate = (
    await call('POST', `/v1/subjects/${holder}/candidates`, {
      statement: (await proposalBody(property, target, position)).statement,
    })
  ).candidate as string;
  await call('POST', `/v1/subjects/${holder}/candidates/${candidate}:accept`, { context, expected_head: null });
  await call('POST', `/v1/subjects/${holder}:adopt`, {
    context,
    property,
    target,
    mode: 'replace',
    expected_head: null,
    selection: [{ candidate, rank: 'normal' }],
  });
  return candidate;
}
async function proposalBody(property: string, target: string, position: number) {
  return {
    statement: {
      property: { id: property },
      value: { type: 'value', content: target },
      qualifiers: [
        {
          property: { id: 'schema:position' },
          value: { type: 'value', content: { amount: `+${position}`, unit: '1' } },
        },
      ],
      references: [
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } }],
        },
      ],
    },
  };
}

let mentor: string;
let pupils: string[];
let faction: string;
let rivals: string[];
let statements: { pupil: string; second: string; faction: string; rival: string };
let growth: GrowthDatabase;

beforeAll(async () => {
  await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'gate:definition_publication');
  expect((await send('POST', '/v1/definitions/releases', { release: base })).status).toBe(201);
  await call('POST', `/v1/definitions/releases/${baseDigest}:activate`, { expected_head: null });
  realm = (await call('POST', '/v1/contexts', { labels: { en: 'Realm' } })).context.id;
  prefix = termPrefix(realm);
  mentorOf = `${prefix}:mentorOf`;
  studentOf = `${prefix}:studentOf`;
  rivalOf = `${prefix}:rivalOf`;
  await grantDefinitions(realm);
  mentor = await character('Mentor');
  pupils = [await character('Pupil 1'), await character('Pupil 2')];
  rivals = [await character('Rival 1')];
  faction = await character('Faction', 'ex:Faction');
  // The Realm adds its relation types; Global has not adopted them.
  const first = await install(realm, extensionOf(realm, realmTerms()), null);
  expect(first.head).toBe(1);
  statements = {
    pupil: await state(mentor, mentorOf, pupils[0]!, 1, realm),
    second: await state(mentor, mentorOf, pupils[1]!, 2, realm),
    faction: await state(mentor, mentorOf, faction, 3, realm),
    rival: await state(pupils[0]!, rivalOf, rivals[0]!, 1, realm),
  };
  await drain();
  growth = await openGrowthDatabase(url);
}, 60_000);
afterAll(async () => {
  await growth?.close();
  await pool.end();
  await admin.end();
});

const relations = (holder: string, property: string, context: string | null, extra = '') =>
  send(
    'GET',
    `/v1/subjects/${holder}/relations?property=${encodeURIComponent(property)}${context ? `&context=${context}` : ''}${extra}`,
  );
const links = (holder: string, property: string, context: string | null, extra = '') =>
  send(
    'GET',
    `/v1/subjects/${holder}/links?property=${encodeURIComponent(property)}${context ? `&context=${context}` : ''}${extra}`,
  );

test("a Context's custom relation type pages, filters and counts like a bundled relation", async () => {
  const active = await call('GET', `/v1/contexts/${realm}/definitions`);
  expect(active.head).toBe(1);
  expect(active.digest).toBe(extensionDigest(extensionOf(realm, realmTerms())));
  expect(Object.keys(active.extension.terms).sort()).toEqual([mentorOf, rivalOf].sort());

  const first = await relations(mentor, mentorOf, realm, '&limit=2');
  expect(first.status).toBe(200);
  expect(first.body.relations.map((row: any) => row.target)).toEqual([pupils[0], pupils[1]]);
  expect(first.body.relations.map((row: any) => row.statement.id)).toEqual([statements.pupil, statements.second]);
  expect(first.body.count).toEqual({ value: 3, exact: true });
  const second = await relations(mentor, mentorOf, realm, `&limit=2&cursor=${encodeURIComponent(first.body.next)}`);
  expect(second.body.relations.map((row: any) => row.target)).toEqual([faction]);
  expect(second.body.next).toBeNull();
  expect(
    (await relations(mentor, mentorOf, realm, '&type=ex:Faction')).body.relations.map((row: any) => row.target),
  ).toEqual([faction]);
  expect((await relations(mentor, mentorOf, realm, '&type=ex:Character')).body.relations).toHaveLength(2);
  expect((await relations(pupils[0]!, rivalOf, realm)).body.relations.map((row: any) => row.target)).toEqual([
    rivals[0],
  ]);

  const inbound = await links(pupils[0]!, mentorOf, realm);
  expect(inbound.body.links.map((row: any) => [row.subject, row.statement])).toEqual([[mentor, statements.pupil]]);
  expect(inbound.body.count).toEqual({ value: 1, exact: true });
  expect((await links(faction, mentorOf, realm, '&type=ex:Character')).body.links).toHaveLength(1);
  expect((await links(faction, mentorOf, realm, '&type=ex:Faction')).body.links).toEqual([]);

  const preview = (await call('GET', `/v1/subjects/${mentor}?context=${realm}`)).subject;
  expect(preview.statements[mentorOf].map((row: any) => row.id)).toEqual([
    statements.pupil,
    statements.second,
    statements.faction,
  ]);
  expect(preview.relationCounts).toEqual({ [mentorOf]: 3, [rivalOf]: 0 });
  expect((await call('GET', `/v1/subjects/${pupils[0]}?context=${realm}`)).subject.relationCounts).toEqual({
    [mentorOf]: 0,
    [rivalOf]: 1,
  });
});

test('a Context without an extension reads the active release unchanged', async () => {
  const plain = (await call('POST', '/v1/contexts', { labels: { en: 'Plain' } })).context.id;
  const active = await effectiveRelease(pool);
  const unextended = await effectiveRelease(pool, plain);
  expect(active!.digest).toBe(baseDigest);
  expect(unextended!.digest).toBe(baseDigest);
  expect(unextended!.release).toBe(active!.release);
  const none = await call('GET', `/v1/contexts/${plain}/definitions`);
  expect(none).toEqual({ context: plain, digest: null, head: 0, extension: null });
});

test("a community Context's custom relation type shows in Global only after Global adopts the term and the statements", async () => {
  // Global does not know the term.
  const unknown = await relations(mentor, mentorOf, null);
  expect(unknown.status).toBe(400);
  const global = (await call('GET', `/v1/subjects/${mentor}`)).subject;
  expect(global.statements[mentorOf]).toBeUndefined();
  expect(global.relationCounts).toEqual({});
  const early = await send('POST', `/v1/subjects/${mentor}/candidates/${statements.pupil}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect(early.status).toBe(400);
  expect(early.body.errors).toContainEqual({ pointer: '/candidate', code: 'unsupported' });

  // Global adopts a term as a copy: the same CURIE and body.
  const terms = realmTerms();
  const altered = await publish(
    GLOBAL_CONTEXT,
    extensionOf(GLOBAL_CONTEXT, { [mentorOf]: { ...terms[mentorOf]!, description: { en: 'Something else.' } } }),
  );
  expect(altered.status).toBe(400);
  expect(altered.body.errors).toEqual([{ pointer: `/extension/terms/${mentorOf}`, code: 'unsupported' }]);
  const unlisted = await publish(GLOBAL_CONTEXT, extensionOf(GLOBAL_CONTEXT, { [`${prefix}:enemyOf`]: term() }));
  expect(unlisted.status).toBe(400);
  expect((await call('GET', `/v1/contexts/${GLOBAL_CONTEXT}/definitions`)).head).toBe(0);
  const adopted = await install(GLOBAL_CONTEXT, extensionOf(GLOBAL_CONTEXT, { [mentorOf]: terms[mentorOf]! }), null);
  expect(adopted.head).toBe(1);
  // The term is known, its statements are not yet Global's.
  const empty = await relations(mentor, mentorOf, null);
  expect(empty.status).toBe(200);
  expect(empty.body.relations).toEqual([]);
  expect(empty.body.count).toEqual({ value: 0, exact: true });
  expect((await call('GET', `/v1/subjects/${mentor}`)).subject.relationCounts).toEqual({ [mentorOf]: 0 });
  expect((await relations(pupils[0]!, rivalOf, null)).status).toBe(400);

  for (const [candidate, target] of [
    [statements.pupil, pupils[0]!],
    [statements.second, pupils[1]!],
  ] as const) {
    await call('POST', `/v1/subjects/${mentor}/candidates/${candidate}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    await call('POST', `/v1/subjects/${mentor}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: mentorOf,
      target,
      mode: 'replace',
      expected_head: null,
      selection: [{ candidate, rank: 'normal' }],
    });
  }
  await drain();
  const adoptedPage = await relations(mentor, mentorOf, null);
  expect(adoptedPage.body.relations.map((row: any) => row.target)).toEqual([pupils[0], pupils[1]]);
  expect(adoptedPage.body.count).toEqual({ value: 2, exact: true });
  expect((await links(pupils[0]!, mentorOf, null)).body.count).toEqual({ value: 1, exact: true });
  // The Realm still shows its own third statement.
  expect((await relations(mentor, mentorOf, realm)).body.count).toEqual({ value: 3, exact: true });
});

test('a custom relation type without a meaning, domain or range is refused', async () => {
  const other = (await call('POST', '/v1/contexts', { labels: { en: 'Refusals' } })).context.id;
  await grantDefinitions(other);
  const key = `${termPrefix(other)}:related`;
  const without = (field: keyof TermDefinition) => {
    const { [field]: _removed, ...rest } = term();
    return extensionOf(other, { [key]: rest as TermDefinition });
  };
  for (const [field, code] of [
    ['description', 'required'],
    ['domain', 'required'],
    ['targets', 'required'],
  ] as const) {
    const refused = await publish(other, without(field));
    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([{ pointer: `/extension/terms/${key}/${field}`, code }]);
  }
  const english = await publish(other, extensionOf(other, { [key]: term({ description: { ja: '関係' } }) }));
  expect(english.body.errors).toEqual([{ pointer: `/extension/terms/${key}/description/en`, code: 'required' }]);
  const emptyDomain = await publish(other, extensionOf(other, { [key]: term({ domain: [], targets: [] }) }));
  expect(emptyDomain.body.errors).toEqual([
    { pointer: `/extension/terms/${key}/domain`, code: 'required' },
    { pointer: `/extension/terms/${key}/targets`, code: 'required' },
  ]);
  // Terms belong to the Context that publishes them, and only to its namespace.
  const foreign = await publish(other, extensionOf(other, { [mentorOf]: term() }));
  expect(foreign.body.errors).toEqual([{ pointer: `/extension/terms/${mentorOf}`, code: 'invalid_format' }]);
  expect((await call('GET', `/v1/contexts/${other}/definitions`)).head).toBe(0);
  // Another Context's editor cannot activate it.
  const published = await publish(other, extensionOf(other, { [key]: term() }));
  expect(published.status).toBe(201);
  await access.revoke({ route: routeOf(other)!, id: other }, 'editor', 'definitions:activate');
  expect((await activate(other, published.body.digest, null)).status).toBe(403);
  await access.grant({ route: routeOf(other)!, id: other }, 'editor', 'definitions:activate');
  expect((await activate(other, `sha256:${'1'.repeat(64)}`, null)).status).toBe(404);
});

test('a custom relation type keeps its meaning for its lifetime', async () => {
  const mine = (await call('POST', '/v1/contexts', { labels: { en: 'Lifetime' } })).context.id;
  await grantDefinitions(mine);
  const named = termPrefix(mine);
  const key = `${named}:mentorOf`;
  const inverse = `${named}:studentOf`;
  const original = term({
    labels: { en: 'mentor of' },
    relation: { group: 'association', inverse, inverseLabels: { en: 'student of' }, acyclic: true },
  });
  const installed = await install(mine, extensionOf(mine, { [key]: original }), null);
  expect(installed.head).toBe(1);
  const refused = async (change: Partial<TermDefinition>, ...pointers: string[]) => {
    const published = await publish(mine, extensionOf(mine, { [key]: { ...original, ...change } }));
    expect(published.status).toBe(201);
    const result = await activate(mine, published.body.digest, 1);
    expect(result.status).toBe(400);
    expect(result.body.errors).toEqual(
      pointers.map((pointer) => ({ pointer: `/extension/terms/${key}${pointer}`, code: 'unsupported' })),
    );
  };
  await refused({ description: { en: 'Something else entirely.' } }, '/description');
  await refused({ domain: ['ex:Faction'] }, '/domain');
  await refused({ targets: ['ex:Faction'] }, '/targets');
  await refused({ multivalued: false }, '/multivalued');
  await refused({ relation: { ...original.relation, group: 'order' } }, '/relation/group');
  await refused(
    { relation: { group: 'association', inverse, inverseLabels: { en: 'student of' } } },
    '/relation/acyclic',
  );
  // Becoming symmetric drops the acyclic flag and the inverse together.
  await refused(
    { relation: { group: 'association', symmetric: true } },
    '/relation/acyclic',
    '/relation/symmetric',
    '/relation/inverse',
  );
  const dropped = await publish(mine, extensionOf(mine, { [`${named}:other`]: term() }));
  const droppedResult = await activate(mine, dropped.body.digest, 1);
  expect(droppedResult.status).toBe(400);
  expect(droppedResult.body.errors).toEqual([{ pointer: `/extension/terms/${key}`, code: 'required' }]);
  expect((await call('GET', `/v1/contexts/${mine}/definitions`)).head).toBe(1);

  // Labels, new terms and deprecation are allowed.
  const successor = `${named}:teacherOf`;
  const next = extensionOf(mine, {
    [key]: {
      ...original,
      labels: { en: 'mentor of', ja: '師匠' },
      relation: { ...original.relation, inverseLabels: { en: 'student of', ja: '弟子' } },
      deprecated: { replacedBy: successor },
    },
    [successor]: term({
      labels: { en: 'teacher of' },
      relation: { group: 'association', inverse: `${named}:pupilOf`, inverseLabels: { en: 'pupil of' } },
    }),
  });
  expect((await install(mine, next, 1)).head).toBe(2);
  // A deprecation stays, and a stale head is refused.
  const undone = await publish(mine, extensionOf(mine, { ...next.terms, [key]: original }));
  expect((await activate(mine, undone.body.digest, 2)).body.errors).toEqual([
    { pointer: `/extension/terms/${key}/deprecated`, code: 'unsupported' },
  ]);
  expect((await activate(mine, undone.body.digest, 1)).status).toBe(409);
});

test("a Context's custom relation types are limited", async () => {
  const limited = (await call('POST', '/v1/contexts', { labels: { en: 'Limited' } })).context.id;
  await grantDefinitions(limited);
  const named = termPrefix(limited);
  const terms = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`${named}:term${index}`, term()]));
  expect((await install(limited, extensionOf(limited, terms(64)), null)).head).toBe(1);
  const over = await publish(limited, extensionOf(limited, terms(65)));
  expect(over.status).toBe(400);
  expect(over.body.errors).toEqual([{ pointer: '/extension/terms', code: 'out_of_range' }]);
  // A deprecated term counts toward the limit.
  const replaced = extensionOf(limited, {
    ...terms(65),
    [`${named}:term0`]: { ...term(), deprecated: { replacedBy: `${named}:term64` } },
  });
  expect((await publish(limited, replaced)).body.errors).toEqual([
    { pointer: '/extension/terms', code: 'out_of_range' },
  ]);
  expect((await call('GET', `/v1/contexts/${limited}/definitions`)).head).toBe(1);
});

test("a Context's term resolution reads a bounded number of rows however many terms the Context holds", async () => {
  const growing = (await call('POST', '/v1/contexts', { labels: { en: 'Growing' } })).context.id;
  const named = termPrefix(growing);
  const holder = await character('Holder', 'ex:Faction');
  const used = `${named}:used`;
  let head = 0;
  const report = await checkGrowth(growth, {
    name: 'Context term resolution',
    scales: [1, 8, 64],
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(db, scale) {
      // The holder's type keeps one term; the rest belong to another type and never enter its read.
      const terms: Record<string, TermDefinition> = {
        [used]: term({ labels: { en: 'used' }, domain: ['ex:Faction'], targets: ['ex:Faction'] }),
      };
      for (let index = 1; index < scale; index++) terms[`${named}:term${index}`] = term();
      const extension = extensionOf(growing, terms);
      head += 1;
      await db.admin.query(
        'INSERT INTO semantic.context_extension(route,context_id,digest,body,recorded_transaction_id) VALUES ($1,$2,$3,$4,$5)',
        [routeOf(growing), growing, extensionDigest(extension), JSON.stringify(extension), randomUUID()],
      );
      await db.admin.query(
        'INSERT INTO semantic.context_extension_activation(route,context_id,head,digest,recorded_transaction_id) VALUES ($1,$2,$3,$4,$5)',
        [routeOf(growing), growing, head, extensionDigest(extension), randomUUID()],
      );
    },
    async operation(db) {
      const read = await readSubject(db.pool, holder, async () => true, growing, new Uint8Array(32).fill(50));
      expect(read!.subject.relationCounts).toEqual({ [used]: 0 });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
}, 60_000);
