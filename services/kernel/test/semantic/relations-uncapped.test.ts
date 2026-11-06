import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, valueSchema, type DataType, type Release } from '@rezics/definitions';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { factDataTypes, itemFacts, type Fact } from '../../src/semantic/item.ts';
import { LINKS_CHANGED, SUBJECT_REVISED } from '../../src/semantic/events.ts';
import { linkChanges } from '../../src/semantic/link-changes.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { holderFacts } from '../../src/semantic/link-keys.ts';
import { updateSubjectIdentity, writeFacts } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const editor = newId(30_000);
const access = await createRealAccess(admin, { editor }, [
  'definitions:publish',
  'definitions:activate',
  'subject:create',
  'subject:read',
  'context:adopt',
]);
const routeKey = new Uint8Array(32).fill(93);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(94)]]) };
const kernel = createKernel({
  pool,
  access: access.access,
  requestDeadlineMs: 30_000,
  writeRate: createWriteRateLimiter({
    secret: 'semantic-relations-uncapped-test-secret',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100, seconds: 60 } } }),
  }),
  tokens,
  routeKey,
  receiptKeys: testReceiptKeys(),
});
const projection = linkProjection(pool);
const editorActions = ['definitions:publish', 'definitions:activate', 'subject:create', 'context:adopt'] as const;
const languages = ['ar', 'en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'pt', 'ru', 'zh', 'nl', 'sv', 'no', 'da'];
const property = (id: string, datatype: DataType, extra: Record<string, unknown> = {}) => ({
  iri: id.startsWith('schema:')
    ? `http://schema.org/${id.slice('schema:'.length)}`
    : id.startsWith('wdt:')
      ? `http://www.wikidata.org/prop/direct/${id.slice('wdt:'.length)}`
      : `https://example.test/${id.slice('ex:'.length)}`,
  labels: { en: id },
  mappings: [],
  datatype,
  multivalued: true,
  qualifiers: [],
  value: valueSchema(datatype, datatype === 'quantity' ? { units: ['1'], integer: true } : {}),
  ...extra,
});

const release: Release = {
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/uncapped-relations', version: '1' },
  generator: { name: 'semantic-test', version: '1' },
  prefixes: {
    ex: 'https://example.test/',
    schema: 'http://schema.org/',
    wdt: 'http://www.wikidata.org/prop/direct/',
  },
  types: {
    'ex:Work': {
      iri: 'https://example.test/Work',
      labels: { en: 'Work' },
      mappings: [],
      bases: [],
      facets: [],
      properties: [
        'ex:appearance',
        'ex:detail',
        'ex:role',
        'ex:unknown',
        'schema:datePublished',
        'schema:position',
        'schema:sameAs',
        'wdt:P453',
        'wdt:P725',
      ],
    },
    'ex:Person': {
      iri: 'https://example.test/Person',
      labels: { en: 'Person' },
      mappings: [],
      bases: [],
      facets: [],
      properties: ['schema:datePublished'],
    },
    'ex:Role': {
      iri: 'https://example.test/Role',
      labels: { en: 'Role' },
      mappings: [],
      bases: [],
      facets: [],
      properties: [],
    },
  },
  properties: {
    'ex:appearance': property('ex:appearance', 'wikibase-item', {
      targets: ['ex:Person'],
      qualifiers: ['ex:role', 'schema:position'],
      relation: { group: 'appearance', inverse: 'none', order: 'position', filter: 'ex:role' },
    }),
    'wdt:P725': property('wdt:P725', 'wikibase-item', {
      targets: ['ex:Person'],
      qualifiers: ['wdt:P453'],
      relation: { group: 'credit', inverse: 'none', order: 'name', slotKey: 'wdt:P453' },
    }),
    'ex:unknown': property('ex:unknown', 'wikibase-item', {
      targets: ['ex:Person'],
      qualifiers: ['schema:sameAs'],
      relation: { group: 'association', inverse: 'none', order: 'name' },
    }),
    'ex:detail': property('ex:detail', 'string'),
    'ex:role': property('ex:role', 'wikibase-item', { targets: ['ex:Role'] }),
    'schema:position': property('schema:position', 'quantity', { units: ['1'] }),
    'schema:sameAs': property('schema:sameAs', 'string'),
    'wdt:P453': property('wdt:P453', 'wikibase-item', { targets: ['ex:Person'] }),
    'schema:datePublished': property('schema:datePublished', 'time'),
  },
};

const digest = releaseDigest(release);
const snak = (propertyId: string, content: unknown) => ({
  property: { id: propertyId },
  value: { type: 'value', content },
});
const statement = (propertyId: string, value: unknown, qualifiers: unknown[] = []) => ({
  property: { id: propertyId },
  value,
  qualifiers,
  references: [],
});
const statementValue = (propertyId: string, target: string, qualifiers: unknown[] = []) =>
  statement(propertyId, { type: 'value', content: target }, qualifiers);

async function response(method: string, path: string, body?: unknown) {
  const answer = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `"${randomUUID()}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response: answer, body: (await answer.json()) as any };
}

async function call(method: string, path: string, body?: unknown) {
  const result = await response(method, path, body);
  if (result.response.status !== 200 && result.response.status !== 201)
    throw new Error(`${method} ${path}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

function descriptiveInput() {
  return {
    type: 'ex:Work',
    labels: Object.fromEntries(languages.map((language) => [language, `Work ${language}`])),
    descriptions: Object.fromEntries(languages.map((language) => [language, `Description ${language}`])),
    aliases: Object.fromEntries(
      languages.map((language) => [language, Array.from({ length: 32 }, (_, index) => `${language} alias ${index}`)]),
    ),
    statements: {
      'ex:detail': [
        statement('ex:detail', { type: 'value', content: 'first detail' }),
        statement('ex:detail', { type: 'value', content: 'second detail' }),
      ],
    },
  };
}

let work = '';
let role = '';
let people: string[] = [];
let appearanceIds: string[] = [];
let voiceIds: string[] = [];
let unknownSameAs: string[] = [];
let revision = 1;

async function catchUp(): Promise<void> {
  const partition = partitionOf(routeOf(work)!);
  for (let step = 0; step < 2_000; step++) {
    const result = await projection.run(partition);
    if (result.status === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    if (result.envelopes === 0) return;
  }
  throw new Error('Semantic link projection did not catch up');
}

async function seedPeople(ids: readonly string[]): Promise<void> {
  const route = routeOf(ids[0]!);
  if (route === null) throw new Error('Character id has no route');
  const subjects: Record<string, unknown>[] = [];
  const revisions: Record<string, unknown>[] = [];
  const facts: Record<string, unknown>[] = [];
  const grants: Record<string, unknown>[] = [];
  for (const [index, id] of ids.entries()) {
    const transactionId = randomUUID();
    const label = `Actor ${String(index).padStart(4, '0')}`;
    const [fact] = itemFacts(id, { labels: { en: label } });
    subjects.push({
      route,
      subject_id: id,
      type: 'ex:Person',
      recorded_transaction_id: transactionId,
      current_facts: 1,
      current_release: digest,
    });
    revisions.push({
      route,
      subject_id: id,
      revision: 1,
      kind: 'create',
      release: digest,
      recorded_transaction_id: transactionId,
    });
    facts.push({ ...fact, route, subject_id: id, recorded_transaction_id: transactionId, release: null });
    grants.push({ route, resource_id: id });
  }
  await admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
     SELECT route,subject_id,type,recorded_transaction_id,current_facts,current_release
     FROM jsonb_to_recordset($1::jsonb) AS row(route integer,subject_id uuid,type text,recorded_transaction_id uuid,current_facts integer,current_release text)`,
    [JSON.stringify(subjects)],
  );
  await admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
     SELECT route,subject_id,revision,kind,release,recorded_transaction_id
     FROM jsonb_to_recordset($1::jsonb) AS row(route integer,subject_id uuid,revision integer,kind text,release text,recorded_transaction_id uuid)`,
    [JSON.stringify(revisions)],
  );
  await admin.query(
    `INSERT INTO semantic.fact(route,subject_id,slot_id,log_seq,operation,kind,language,property,statement_id,body,recorded_transaction_id,release)
     SELECT route,subject_id,slot_id,log_seq,operation,kind,language,property,statement_id,body,recorded_transaction_id,release
     FROM jsonb_to_recordset($1::jsonb) AS row(route integer,subject_id uuid,slot_id uuid,log_seq integer,operation text,kind text,language text,property text,statement_id uuid,body jsonb,recorded_transaction_id uuid,release text)`,
    [JSON.stringify(facts)],
  );
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
     SELECT route,resource_id,$2,'','subject:read','(,)'::tstzrange,$2
     FROM jsonb_to_recordset($1::jsonb) AS row(route integer,resource_id uuid)`,
    [JSON.stringify(grants), editor],
  );
  await admin.query('UPDATE semantic.partition_subjects SET visible = visible + $2 WHERE partition_no = $1', [
    partitionOf(route),
    ids.length,
  ]);
}

async function appendFacts(facts: Fact[]): Promise<void> {
  if (facts.length > 512) throw new Error(`Seed command exceeds the fact limit: ${facts.length}`);
  const route = routeOf(work)!;
  const partition = partitionOf(route);
  const nextRevision = ++revision;
  await runCommand(pool, { partition }, async (tx, { transactionId }) => {
    await tx.query(
      `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
       VALUES ($1,$2,$3,'adopt',$4,$5)`,
      [route, work, nextRevision, digest, transactionId],
    );
    await tx.query('UPDATE semantic.subject SET current_release=$3 WHERE route=$1 AND subject_id=$2', [
      route,
      work,
      digest,
    ]);
    const stored = facts.map((fact) => ({ ...fact, release: fact.kind === 'statement' ? digest : null }));
    await writeFacts(tx, { route, subject_id: work, transaction_id: transactionId, facts: stored });
    const identity = await holderFacts(tx, work, release);
    const changes = linkChanges([], stored, factDataTypes(release, stored), {
      subject: work,
      release,
      type: 'ex:Work',
      identityFacts: identity.facts,
    });
    return {
      value: null,
      events: [
        { type: SUBJECT_REVISED, subject: work, data: { id: work, revision: nextRevision, kind: 'adopt' } },
        {
          type: LINKS_CHANGED,
          subject: work,
          data: { subject: work, revision: nextRevision, security_revision: 0, changes },
        },
      ],
    };
  });
}

function position(value: number) {
  return snak('schema:position', { amount: `+${value}`, unit: '1' });
}

async function appendRelations(): Promise<void> {
  const roleQualifier = snak('ex:role', role);
  const appearances = people.map((target, index) =>
    statementValue('ex:appearance', target, [roleQualifier, position(index + 1)]),
  );
  const voices = people.map((target, index) => {
    const actor = index < 2 ? people[0]! : target;
    const character = index === 0 ? people[1]! : index === 1 ? people[2]! : people[0]!;
    return statementValue('wdt:P725', actor, [snak('wdt:P453', character)]);
  });
  const facts: Fact[] = [];
  for (let offset = 0; offset < people.length; offset += 32) {
    facts.push(
      ...itemFacts(
        work,
        {
          labels: { en: 'Uncapped work' },
          statements: {
            'ex:appearance': appearances.slice(offset, offset + 32),
            'wdt:P725': voices.slice(offset, offset + 32),
          },
        },
        'ex:Work',
        release,
      ).filter((fact) => fact.kind === 'statement'),
    );
  }
  for (let offset = 0; offset < facts.length; offset += 512) await appendFacts(facts.slice(offset, offset + 512));
  appearanceIds = facts.filter((fact) => fact.property === 'ex:appearance').map((fact) => fact.statement_id!);
  voiceIds = facts.filter((fact) => fact.property === 'wdt:P725').map((fact) => fact.statement_id!);

  unknownSameAs = Array.from(
    { length: 200 },
    (_, index) => `https://www.wikidata.org/entity/Q${String(900_000 + index)}`,
  );
  const unknown = [
    statementValue('ex:unknown', people[0]!),
    ...unknownSameAs.map((iri) => statement('ex:unknown', { type: 'somevalue' }, [snak('schema:sameAs', iri)])),
    statement('ex:unknown', { type: 'somevalue' }),
    statement('ex:unknown', { type: 'novalue' }),
  ];
  for (let offset = 0; offset < unknown.length; offset += 32) {
    const facts = itemFacts(
      work,
      { labels: { en: 'Uncapped work' }, statements: { 'ex:unknown': unknown.slice(offset, offset + 32) } },
      'ex:Work',
      release,
    ).filter((fact) => fact.kind === 'statement');
    await appendFacts(facts);
  }
}

async function pageAll(propertyId: string, filter?: string, type?: string) {
  const relations: any[] = [];
  let cursor: string | null = null;
  let expectedCount: unknown;
  do {
    const query = new URLSearchParams({ property: propertyId, limit: '100' });
    if (filter) query.set('filter', filter);
    if (type) query.set('type', type);
    if (cursor) query.set('cursor', cursor);
    const page = await call('GET', `/v1/subjects/${work}/relations?${query}`);
    expectedCount = page.count;
    relations.push(...page.relations);
    cursor = page.next;
  } while (cursor);
  return { relations, count: expectedCount };
}

beforeAll(async () => {
  for (const action of editorActions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  const published = await call('POST', '/v1/definitions/releases', { release });
  await call('POST', `/v1/definitions/releases/${published.digest}:activate`, { expected_head: null });
  role = (await call('POST', '/v1/subjects', { type: 'ex:Role', labels: { en: 'Lead role' } })).subject.id;
  const created = await call('POST', '/v1/subjects', descriptiveInput());
  work = created.subject.id;
  await access.grant({ route: routeOf(work)!, id: work }, 'editor', 'subject:read');
  const route = routeOf(work)!;
  people = Array.from({ length: 3_000 }, () => newId(route));
  await seedPeople(people);
  await appendRelations();
  await catchUp();
}, 120_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

test('A work holds thousands of appearances and credits beyond the descriptive fact cap', async () => {
  const row = await admin.query('SELECT current_facts FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
    routeOf(work),
    work,
  ]);
  expect(row.rows[0]?.current_facts).toBe(512);
  expect(appearanceIds).toHaveLength(3_000);
  expect(voiceIds).toHaveLength(3_000);
  const facts = await admin.query(
    `SELECT count(*)::integer AS value FROM semantic.fact WHERE route=$1 AND subject_id=$2 AND kind='statement' AND operation='assert'`,
    [routeOf(work), work],
  );
  expect(facts.rows[0]?.value).toBe(6_205);
});

test('The descriptive fact cap still refuses the 513th label', async () => {
  await expect(
    updateSubjectIdentity(pool, {
      subject: work,
      labels: { en: 'A label beyond the descriptive cap' },
      release: { digest, release },
      authorize: async () => true,
    }),
  ).rejects.toMatchObject({ name: 'SubjectInputError' });
});

test('The subject read returns a bounded preview without unproved public relation counts', async () => {
  const answer = await call('GET', `/v1/subjects/${work}`);
  expect(answer.subject.statements['ex:appearance']).toHaveLength(12);
  expect(answer.subject.statements['wdt:P725']).toHaveLength(12);
  expect(answer.subject.statements['ex:unknown']).toHaveLength(12);
  expect(answer.subject.relationCounts).toEqual({});
});

test('A forward relation page orders, filters and continues across all relations without unproved counts', async () => {
  const appearance = await pageAll('ex:appearance');
  expect(appearance).not.toHaveProperty('count');
  expect(appearance.relations.map((entry) => entry.statement.id)).toEqual(appearanceIds);
  const filtered = await pageAll('ex:appearance', role);
  expect(filtered).not.toHaveProperty('count');
  expect(filtered.relations.map((entry) => entry.statement.id)).toEqual(appearanceIds);

  const voices = await pageAll('wdt:P725');
  expect(voices).not.toHaveProperty('count');
  expect(voices.relations.map((entry) => entry.target)).toEqual([people[0], people[0], ...people.slice(2)]);
  expect(voices.relations.map((entry) => entry.statement.id).toSorted()).toEqual(voiceIds.toSorted());

  const typed = await call(
    'GET',
    `/v1/subjects/${work}/relations?property=ex%3Aappearance&filter=${role}&type=ex%3APerson&limit=25`,
  );
  expect(typed.relations).toHaveLength(25);
  expect(typed).not.toHaveProperty('count');
  expect(typed.next).not.toBeNull();

  const unknown = await pageAll('ex:unknown');
  expect(unknown).not.toHaveProperty('count');
  expect(unknown.relations).toHaveLength(203);
  expect(unknown.relations[0]?.target).toBe(people[0]);
  expect(unknown.relations.slice(1).filter((entry) => entry.external !== null)).toHaveLength(200);
  expect(unknown.relations.filter((entry) => entry.external !== null).map((entry) => entry.external)).toEqual(
    unknownSameAs,
  );
  expect(unknown.relations.slice(1).every((entry) => entry.target === null)).toBe(true);
  expect(
    unknown.relations
      .slice(1)
      .map((entry) => entry.statement.value.type)
      .toSorted(),
  ).toEqual([...Array.from({ length: 200 }, () => 'somevalue'), 'somevalue', 'novalue'].toSorted());
}, 120_000);

test('The relation API addresses target, external-IRI and property-level slots', async () => {
  const created = await call('POST', '/v1/subjects', {
    type: 'ex:Work',
    labels: { en: 'Relation slot work' },
    statements: {
      'wdt:P725': [statementValue('wdt:P725', people[0]!, [snak('wdt:P453', people[1]!)])],
      'ex:unknown': [
        statement('ex:unknown', { type: 'somevalue' }, [snak('schema:sameAs', unknownSameAs[0])]),
        statement('ex:unknown', { type: 'somevalue' }),
        statement('ex:unknown', { type: 'novalue' }),
      ],
    },
  });
  const apiWork = created.subject.id;
  await access.grant({ route: routeOf(apiWork)!, id: apiWork }, 'editor', 'subject:read');
  const target = people[0]!;
  const key = people[1]!;
  const sameAs = unknownSameAs[0]!;
  const targetCandidates = await call(
    'GET',
    `/v1/subjects/${apiWork}/candidates?property=wdt%3AP725&target=${target}&key=${key}`,
  );
  expect(targetCandidates.candidates).toHaveLength(1);
  expect(targetCandidates.candidates[0].statement.value.content).toBe(target);

  const externalCandidates = await call(
    'GET',
    `/v1/subjects/${apiWork}/candidates?property=ex%3Aunknown&sameAs=${encodeURIComponent(sameAs)}`,
  );
  expect(externalCandidates.candidates).toHaveLength(1);
  expect(externalCandidates.candidates[0].statement.value.type).toBe('somevalue');

  const propertyCandidates = await call('GET', `/v1/subjects/${apiWork}/candidates?property=ex%3Aunknown`);
  expect(propertyCandidates.candidates.map((entry: any) => entry.statement.value.type).toSorted()).toEqual([
    'novalue',
    'somevalue',
  ]);

  const targetAdoption = await call('POST', `/v1/subjects/${apiWork}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'wdt:P725',
    target,
    key,
    mode: 'replace',
    selection: [{ candidate: targetCandidates.candidates[0].id, rank: 'normal' }],
    expected_head: targetCandidates.adoption?.head ?? null,
  });
  expect(targetAdoption.adoption.selection).toHaveLength(1);
  const externalAdoption = await call('POST', `/v1/subjects/${apiWork}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'ex:unknown',
    sameAs,
    mode: 'replace',
    selection: [{ candidate: externalCandidates.candidates[0].id, rank: 'normal' }],
    expected_head: externalCandidates.adoption?.head ?? null,
  });
  expect(externalAdoption.adoption.selection).toHaveLength(1);
  const propertyAdoption = await call('POST', `/v1/subjects/${apiWork}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'ex:unknown',
    mode: 'replace',
    selection: propertyCandidates.candidates.map((entry: any) => ({ candidate: entry.id, rank: 'normal' })),
    expected_head: propertyCandidates.adoption?.head ?? null,
  });
  expect(propertyAdoption.adoption.selection).toHaveLength(2);
});

test("A target's renamed label reorders the holder's forward page after projection catch-up", async () => {
  const before = await call('GET', `/v1/subjects/${work}/relations?property=wdt%3AP725&limit=2`);
  expect(before.relations.map((entry: any) => entry.target)).toEqual([people[0], people[0]]);
  await updateSubjectIdentity(pool, {
    subject: people[0]!,
    labels: { en: 'Zulu actor' },
    release: { digest, release },
    authorize: async () => true,
  });
  await catchUp();
  const after = await pageAll('wdt:P725');
  expect(after.relations.slice(0, 2).every((entry) => entry.target !== people[0])).toBe(true);
  expect(after.relations.slice(-2).map((entry) => entry.target)).toEqual([people[0], people[0]]);
});
