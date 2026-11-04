import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest, type Release } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const accounts = { editor: newId(0x6a10), moderator: newId(0x6a20) };
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'presentation:read',
  'definitions:publish',
  'definitions:activate',
  'gate:definition_publication',
];
const real = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: real.access,
  writeRate: real.writeRate,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(81)]]) },
  routeKey: new Uint8Array(32).fill(82),
  receiptKeys: testReceiptKeys(),
});
const projection = linkProjection(pool);
const relays = startRelays(pool, [projection], { intervalMs: 20 });
const sessions = new Map<string, string>();
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
type Persona = keyof typeof accounts | undefined;
const reference = {
  parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/source' } }],
};
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value', content } });
const year = (time: string) => ({ time, precision: 9, calendarmodel: GREGORIAN });

function pageSubject(page: { reads: Record<string, { status: number; body: any }> }, id: string) {
  const entry = Object.values(page.reads).find((read) => read.status === 200 && read.body?.subject?.id === id);
  expect(entry).toBeDefined();
  return entry!.body as { subject: any; documents?: Record<string, { availability?: string }> };
}

function correctionState(page: { actions?: { action: string; operationId: string; state: string }[] }, action: string) {
  return page.actions?.find((entry) => entry.action === action);
}

async function call(method: string, path: string, as?: Persona, body?: unknown, key = randomUUID()) {
  const headers: Record<string, string> = {};
  if (as) {
    headers.authorization = `Bearer ${real.bearer(as)}`;
    const session = sessions.get(as);
    if (session) headers['rezics-session-token'] = session;
  }
  if (method === 'POST') headers['idempotency-key'] = `"${key}"`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const session = response.headers.get('rezics-session-token');
  if (as && session) sessions.set(as, session);
  return { status: response.status, headers: response.headers, body: (await response.json()) as any };
}

async function created(type: string, labels: Record<string, string>, statements: Record<string, unknown[]> = {}) {
  const result = await call('POST', '/v1/subjects', 'editor', { type, labels, statements });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.subject as { id: string; revision: number; statements: Record<string, any[]> };
}

async function catchUp(id: string) {
  for (let i = 0; i < 200; i++) {
    const result = await projection.run(partitionOf(routeOf(id)!));
    if (result.status === 'read' && result.envelopes === 0) return;
    await Bun.sleep(5);
  }
  throw new Error('Projection did not drain');
}

async function proposed(id: string, statement: unknown) {
  return call('POST', `/v1/subjects/${id}/candidates`, 'editor', { statement });
}

async function adopted(id: string, property: string, candidate: string, target?: string) {
  const accepted = await call('POST', `/v1/subjects/${id}/candidates/${candidate}:accept`, 'editor', {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const result = await call('POST', `/v1/subjects/${id}:adopt`, 'editor', {
    context: GLOBAL_CONTEXT,
    property,
    ...(target ? { target } : {}),
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

function olderRelease(): Release {
  const release = structuredClone(bundledRelease) as Release;
  release.catalogue = { ...release.catalogue, version: '1.0.1-history-control' };
  for (const id of ['wdt:P106', 'schema:knowsLanguage', 'wdt:P749', 'wdt:P1365', 'wdt:P1366'] as const)
    delete release.properties[id];
  for (const type of ['schema:Person', 'schema:Organization'] as const) {
    const definition = release.types[type];
    if (definition)
      definition.properties = definition.properties.filter(
        (id) =>
          id !== 'schema:abstract' &&
          id !== 'wdt:P106' &&
          id !== 'schema:knowsLanguage' &&
          id !== 'wdt:P749' &&
          id !== 'wdt:P1365' &&
          id !== 'wdt:P1366',
      );
  }
  return release;
}

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  await setupPresentation(pool);
  for (const as of Object.keys(accounts) as (keyof typeof accounts)[])
    for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, as, action);
});
afterAll(async () => {
  await relays.stop();
  await Promise.all([pool.end(), admin.end()]);
});

test('a reader follows sourced biography occupations and languages and an editor inspects native review', async () => {
  const director = await created('skos:Concept', { en: 'Director' });
  const writer = await created('skos:Concept', { en: 'Writer' });
  const japanese = await created('skos:Concept', { en: 'Japanese' });
  const english = await created('skos:Concept', { en: 'English' });
  const person = await created(
    'schema:Person',
    { en: 'Mira Sato' },
    {
      'schema:abstract': [
        {
          ...snak('schema:abstract', {
            document: fromPlainText('English biography of the contributor.'),
            licence: 'CC-BY-4.0',
            language: 'en',
          }),
          references: [reference],
        },
        {
          ...snak('schema:abstract', {
            document: fromPlainText('この人物の日本語の伝記。'),
            licence: 'CC-BY-4.0',
            language: 'ja',
          }),
          references: [reference],
        },
      ],
      'wdt:P106': [
        { ...snak('wdt:P106', director.id), references: [reference] },
        { ...snak('wdt:P106', writer.id), references: [reference] },
      ],
      'schema:knowsLanguage': [
        { ...snak('schema:knowsLanguage', japanese.id), references: [reference] },
        { ...snak('schema:knowsLanguage', english.id), references: [reference] },
      ],
    },
  );
  const current = await call('GET', `/v1/subjects/${person.id}`);
  expect(current.status).toBe(200);
  expect(current.body.subject.statements['wdt:P106'].map((row: any) => row.value.content).sort()).toEqual(
    [director.id, writer.id].sort(),
  );
  expect(current.body.subject.statements['schema:knowsLanguage'].map((row: any) => row.value.content).sort()).toEqual(
    [japanese.id, english.id].sort(),
  );
  expect(current.body.subject.statements['schema:abstract']).toHaveLength(2);
  const page = await call('POST', '/v1/pages:read', 'editor', { target: { subject: person.id } });
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  expect(page.headers.get('cache-control')).toBe('private, no-store');
  expect(page.body.subject).toBe(person.id);
  expect(page.body.viewer).toEqual({ kind: 'account' });
  expect(correctionState(page.body, 'statement:propose')).toEqual({
    action: 'statement:propose',
    operationId: 'subject.propose',
    state: 'allowed',
  });
  const filled = pageSubject(page.body, person.id);
  expect(filled.subject.statements['schema:abstract']).toHaveLength(2);
  expect(Object.values(filled.documents ?? {}).some((document) => document.availability === 'available')).toBe(true);
  const publicPage = await call('POST', '/v1/pages:read', undefined, { target: { subject: person.id } });
  expect(publicPage.status).toBe(200);
  expect(publicPage.body.viewer).toEqual({ kind: 'anonymous' });
  expect(correctionState(publicPage.body, 'statement:propose')).toMatchObject({
    action: 'statement:propose',
    state: 'denied',
  });
  const anonymous = await call('POST', `/v1/subjects/${person.id}/candidates`, undefined, {
    statement: { ...snak('wdt:P106', director.id), references: [reference] },
  });
  expect([401, 403]).toContain(anonymous.status);
  const extra = await created('skos:Concept', { en: 'Composer' });
  const proposal = await proposed(person.id, { ...snak('wdt:P106', extra.id), references: [reference] });
  expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  const afterPropose = await call('GET', `/v1/subjects/${person.id}`);
  expect(afterPropose.body.subject.statements['wdt:P106'].map((row: any) => row.value.content)).not.toContain(extra.id);
  const review = await call(
    'GET',
    `/v1/subjects/${person.id}/candidates?property=${encodeURIComponent('wdt:P106')}&target=${extra.id}`,
    'editor',
  );
  expect(review.status).toBe(200);
  expect(review.body.candidates.map((row: any) => row.id)).toContain(proposal.body.candidate);
  const wrong = await proposed(person.id, {
    ...snak('wdt:P106', person.id),
    references: [reference],
  });
  expect(wrong.status).toBe(400);
  expect(wrong.body.errors?.some((error: { code: string }) => error.code === 'out_of_range')).toBe(true);
  await call('POST', `/v1/subjects/${director.id}:hide`, 'moderator', { reason: 'Concealed occupation concept' });
  const concealed = await call('GET', `/v1/subjects/${person.id}`);
  const hidden = concealed.body.subject.statements['wdt:P106'].find((row: any) => row.value.content === director.id);
  expect(hidden === undefined || concealed.body.related?.[director.id] === undefined).toBe(true);
});

test('a reader follows directed parent and replacement history and returns to the exact assertion', async () => {
  const parent = await created('schema:Organization', { en: 'Lantern Holdings' });
  const predecessor = await created('schema:Organization', { en: 'Old Lantern' });
  const successor = await created('schema:Organization', { en: 'New Lantern' });
  const studio = await created(
    'schema:Organization',
    { en: 'Lantern Studio' },
    {
      'schema:abstract': [
        {
          ...snak('schema:abstract', {
            document: fromPlainText('Studio history written as a document.'),
            licence: 'CC-BY-4.0',
            language: 'en',
          }),
          references: [reference],
        },
      ],
    },
  );
  const person = await created('schema:Person', { en: 'Not an organization' });
  const parentFact = {
    ...snak('wdt:P749', parent.id),
    qualifiers: [
      { property: { id: 'schema:startDate' }, value: { type: 'value', content: year('+1999-00-00T00:00:00Z') } },
      { property: { id: 'schema:endDate' }, value: { type: 'value', content: year('+2001-00-00T00:00:00Z') } },
    ],
    references: [reference],
  };
  const parentProposal = await proposed(studio.id, parentFact);
  expect(parentProposal.status, JSON.stringify(parentProposal.body)).toBe(201);
  await adopted(studio.id, 'wdt:P749', parentProposal.body.candidate, parent.id);
  const predecessorProposal = await proposed(studio.id, {
    ...snak('wdt:P1365', predecessor.id),
    references: [reference],
  });
  await adopted(studio.id, 'wdt:P1365', predecessorProposal.body.candidate, predecessor.id);
  const successorProposal = await proposed(studio.id, { ...snak('wdt:P1366', successor.id), references: [reference] });
  await adopted(studio.id, 'wdt:P1366', successorProposal.body.candidate, successor.id);
  await catchUp(studio.id);
  const current = await call('GET', `/v1/subjects/${studio.id}`);
  const parentStatement = current.body.subject.statements['wdt:P749'][0];
  expect(parentStatement.value.content).toBe(parent.id);
  expect(parentStatement.qualifiers.map((part: any) => part.property.id).sort()).toEqual([
    'schema:endDate',
    'schema:startDate',
  ]);
  expect(current.body.subject.statements['wdt:P1365'][0].value.content).toBe(predecessor.id);
  expect(current.body.subject.statements['wdt:P1366'][0].value.content).toBe(successor.id);
  const page = await call('POST', '/v1/pages:read', 'editor', { target: { subject: studio.id } });
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  expect(page.body.subject).toBe(studio.id);
  expect(page.body.viewer).toEqual({ kind: 'account' });
  expect(correctionState(page.body, 'statement:propose')?.state).toBe('allowed');
  expect(Object.keys(pageSubject(page.body, studio.id).documents ?? {}).length).toBeGreaterThan(0);
  const forward = await call(
    'GET',
    `/v1/subjects/${studio.id}/relations?property=${encodeURIComponent('wdt:P749')}&limit=20`,
    'editor',
  );
  expect(forward.status).toBe(200);
  expect(forward.body.relations.map((row: any) => row.summary?.id ?? row.summary)).toEqual(
    expect.arrayContaining([parent.id]),
  );
  const inverse = await call(
    'GET',
    `/v1/subjects/${parent.id}/links?property=${encodeURIComponent('wdt:P749')}&limit=20`,
    'editor',
  );
  expect(inverse.status).toBe(200);
  expect(inverse.body.links.some((row: any) => row.subject === studio.id)).toBe(true);
  const wrong = await proposed(studio.id, { ...snak('wdt:P749', person.id), references: [reference] });
  expect(wrong.status).toBe(400);
  expect(wrong.body.errors?.some((error: { code: string }) => error.code === 'out_of_range')).toBe(true);
  await call('POST', `/v1/subjects/${predecessor.id}:hide`, 'moderator', { reason: 'Concealed predecessor' });
  const afterHide = await call(
    'GET',
    `/v1/subjects/${studio.id}/relations?property=${encodeURIComponent('wdt:P1365')}&limit=20`,
    'editor',
  );
  const concealed = afterHide.body.relations.find(
    (row: any) => row.statement?.id === predecessorProposal.body.candidate,
  );
  expect(concealed === undefined || concealed.summary == null).toBe(true);
  const correction = await proposed(studio.id, { ...snak('wdt:P1366', successor.id), references: [reference] });
  expect(correction.status).toBe(201);
  const candidates = await call(
    'GET',
    `/v1/subjects/${studio.id}/candidates?property=${encodeURIComponent('wdt:P1366')}&target=${successor.id}`,
    'editor',
  );
  expect(candidates.body.candidates.map((row: any) => row.id)).toContain(correction.body.candidate);
  const publicStudio = await call('GET', `/v1/subjects/${studio.id}`);
  expect(publicStudio.body.subject.id).toBe(studio.id);
  expect(publicStudio.body.subject.statements['wdt:P1366'][0].id).not.toBe(correction.body.candidate);
});

test('old immutable release withholds biography and producer fields that the current release admits', async () => {
  const old = olderRelease();
  const digest = releaseDigest(old);
  const published = await call('POST', '/v1/definitions/releases', 'editor', { release: old });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  expect(published.body.digest).toBe(digest);
  const activated = await call('POST', `/v1/definitions/releases/${digest}:activate`, 'editor', {
    expected_head: 1,
  });
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  const concept = await created('skos:Concept', { en: 'Director on old release' });
  const person = await created('schema:Person', { en: 'Historical pin person' });
  const refused = await proposed(person.id, { ...snak('wdt:P106', concept.id), references: [reference] });
  expect(refused.status).toBe(400);
  const restored = await call('POST', `/v1/definitions/releases/${bundledDigest}:activate`, 'editor', {
    expected_head: activated.body.head,
  });
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const admitted = await proposed(person.id, { ...snak('wdt:P106', concept.id), references: [reference] });
  expect(admitted.status, JSON.stringify(admitted.body)).toBe(201);
  const pinned = await call('GET', `/v1/definitions/releases/${digest}`);
  expect(pinned.status).toBe(200);
  expect(pinned.body.digest).toBe(digest);
  expect(pinned.body.release.properties['wdt:P106']).toBeUndefined();
  const current = await call('GET', `/v1/definitions/releases/${bundledDigest}`);
  expect(current.body.release.properties['wdt:P106']).toBeDefined();
  expect(current.body.release.properties['wdt:P749']).toBeDefined();
});
