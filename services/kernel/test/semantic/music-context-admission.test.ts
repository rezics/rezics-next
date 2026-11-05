import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string; outsider: string }>>>;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000271';
const outsider = '019a1b2c-3d4e-7f00-8a00-ed170e000272';
const routeKey = new Uint8Array(32).fill(123);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(124)]]) };
const actions = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'presentation:read',
];
const value = (content: unknown) => ({ type: 'value', content });
const part = (property: string, content: unknown) => ({ property: { id: property }, value: value(content) });
const source = (url: string) => ({ parts: [part('schema:url', url)] });
const fact = (
  property: string,
  content: unknown,
  qualifiers: unknown[] = [],
  url = 'https://source.example.test/music',
) => ({
  property: { id: property },
  value: typeof content === 'object' && content !== null && 'type' in content ? content : value(content),
  qualifiers,
  references: [source(url)],
});
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: {
        root: { props: {} },
        content: [
          { type: 'SubjectHeader', props: { id: 'header' } },
          { type: 'Statements', props: { id: 'event-times', properties: ['schema:startDate', 'schema:endDate'] } },
          { type: 'RelationGroups', props: { id: 'event-places', property: 'schema:location', limit: 20 } },
          { type: 'RelationGroups', props: { id: 'event-performers', property: 'schema:performer', limit: 20 } },
        ],
      },
    },
  },
  bases: [],
  types: [],
  routes: [],
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, profile);
  real = await createRealAccess(db.admin, { editor, outsider }, actions);
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({ pool: db.pool, routeKey, tokens, access: real.access, writeRate: real.writeRate });
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

async function send(
  method: string,
  path: string,
  body?: unknown,
  actor: 'editor' | 'outsider' | 'anonymous' = 'editor',
  key?: string,
) {
  const headers: Record<string, string> = {};
  if (actor !== 'anonymous') headers.authorization = `Bearer ${real.bearer(actor)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (body !== undefined && method !== 'GET' && !path.endsWith('/v1/pages:read'))
    headers['idempotency-key'] = key ?? `"${randomUUID()}"`;
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function write(path: string, body: unknown, expected = 200) {
  const key = `"${randomUUID()}"`;
  let result = await send('POST', path, body, 'editor', key);
  for (
    let retry = 0;
    retry < 2 &&
    result.response.status === 503 &&
    result.body.code === 'overloaded' &&
    result.body.retryable === true &&
    result.body.effect_status === 'not_applied';
    retry++
  ) {
    result = await send('POST', path, body, 'editor', key);
  }
  expect([path, result.response.status, result.response.status === expected ? null : result.body]).toEqual([
    path,
    expected,
    null,
  ]);
  return result.body;
}

async function create(type: string, label: string) {
  return (await write('/v1/subjects', { type, labels: { en: label } }, 201)).subject as {
    id: string;
    type: string;
  };
}

async function proposeAcceptAdopt(subject: string, statement: ReturnType<typeof fact>) {
  const candidate = (await write(`/v1/subjects/${subject}/candidates`, { statement }, 201)).candidate as string;
  await write(`/v1/subjects/${subject}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  await write(`/v1/subjects/${subject}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: statement.property.id,
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  return candidate;
}

test('released music context Types admit sourced identities, facts, exact credits and public current reads', async () => {
  const genericPlace = await create('schema:Place', 'Harbor district grounds');
  const area = await create('schema:AdministrativeArea', 'Port district');
  const venue = await create('schema:MusicVenue', 'Harbor Stage');
  const genericEvent = await create('schema:Event', 'Harbor programme');
  const event = await create('schema:MusicEvent', 'Harbor music festival');
  const instrument = await create('wd:Q34379', 'Electric guitar');
  const artist = await create('schema:Person', 'Harbor Quartet');
  const role = await create('skos:Concept', 'Performer');
  expect([genericPlace.type, area.type, venue.type, genericEvent.type, event.type, instrument.type]).toEqual([
    'schema:Place',
    'schema:AdministrativeArea',
    'schema:MusicVenue',
    'schema:Event',
    'schema:MusicEvent',
    'wd:Q34379',
  ]);

  await proposeAcceptAdopt(
    venue.id,
    fact('schema:containedInPlace', area.id, [], 'https://music.example.test/venue-location'),
  );
  await proposeAcceptAdopt(
    event.id,
    fact('schema:location', venue.id, [], 'https://music.example.test/event-location'),
  );
  await proposeAcceptAdopt(
    event.id,
    fact(
      'schema:startDate',
      { time: '+2025-06-00T00:00:00Z', precision: 10, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
      [],
      'https://music.example.test/event-date',
    ),
  );
  await proposeAcceptAdopt(
    event.id,
    fact('schema:endDate', { type: 'somevalue' }, [], 'https://music.example.test/event-end-date'),
  );
  const credit = fact(
    'schema:performer',
    artist.id,
    [part('wdt:P1303', instrument.id), part('wdt:P1932', 'Harbor Quartet'), part('wdt:P3831', role.id)],
    'https://music.example.test/performer-credit',
  );
  await proposeAcceptAdopt(event.id, credit);

  const venueRead = await send('GET', `/v1/subjects/${venue.id}`, undefined, 'anonymous');
  expect(venueRead.response.status).toBe(200);
  expect(venueRead.body.subject.statements['schema:containedInPlace'][0]).toMatchObject({
    value: value(area.id),
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: value('https://music.example.test/venue-location') }] },
    ],
  });
  const eventRead = await send('GET', `/v1/subjects/${event.id}`, undefined, 'anonymous');
  expect(eventRead.response.status).toBe(200);
  expect(eventRead.body.subject).toMatchObject({ type: 'schema:MusicEvent', release: bundledDigest });
  expect(eventRead.body.subject.statements['schema:startDate'][0].value.content).toEqual({
    time: '+2025-06-00T00:00:00Z',
    precision: 10,
    calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
  });
  expect(eventRead.body.subject.statements['schema:endDate'][0].value.type).toBe('somevalue');
  expect(eventRead.body.subject.statements['schema:performer'][0]).toMatchObject({
    value: value(artist.id),
    qualifiers: [
      { property: { id: 'wdt:P1303' }, value: value(instrument.id) },
      { property: { id: 'wdt:P1932' }, value: value('Harbor Quartet') },
      { property: { id: 'wdt:P3831' }, value: value(role.id) },
    ],
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: value('https://music.example.test/performer-credit') }] },
    ],
  });

  const relations = await send(
    'GET',
    `/v1/subjects/${event.id}/relations?property=schema:performer&context=${GLOBAL_CONTEXT}&limit=20`,
    undefined,
    'anonymous',
  );
  expect(relations.response.status).toBe(200);
  expect(relations.body.relations[0]).toMatchObject({
    statement: {
      value: value(artist.id),
      qualifiers: [{ property: { id: 'wdt:P1303' }, value: value(instrument.id) }],
    },
    related: {
      [instrument.id]: { id: instrument.id, type: 'wd:Q34379', label: { value: 'Electric guitar', language: 'en' } },
    },
  });

  const wrongTarget = await send('POST', `/v1/subjects/${event.id}/candidates`, {
    statement: fact('schema:location', artist.id),
  });
  expect([400, 422]).toContain(wrongTarget.response.status);
  const malformedTime = await send('POST', `/v1/subjects/${event.id}/candidates`, {
    statement: fact('schema:startDate', {
      time: '+2025-99-99T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    }),
  });
  expect([400, 422]).toContain(malformedTime.response.status);
  const wrongInstrument = await send('POST', `/v1/subjects/${event.id}/candidates`, {
    statement: fact('schema:performer', artist.id, [part('wdt:P1303', artist.id)]),
  });
  expect([400, 422]).toContain(wrongInstrument.response.status);

  const page = await send('POST', '/v1/pages:read', { target: { subject: event.id }, languages: ['en'] });
  expect(page.response.status).toBe(200);
  expect(page.body.catalogue).toMatchObject({ state: 'released', type: 'schema:MusicEvent', digest: bundledDigest });
  expect(page.body.catalogue.definitions.properties).toHaveProperty('schema:location');
  expect(page.body.catalogue.definitions.properties).toHaveProperty('wdt:P1303');
  expect(page.body.viewer).toMatchObject({
    state: 'account',
    account: editor,
    context: GLOBAL_CONTEXT,
    actions: { statementPropose: 'allowed' },
  });
  expect(
    Object.values(page.body.reads).some((read: any) => read.status === 200 && read.body.subject?.id === event.id),
  ).toBe(true);
  const anonymous = await send(
    'POST',
    '/v1/pages:read',
    { target: { subject: event.id }, languages: ['en'] },
    'anonymous',
  );
  expect(anonymous.body.viewer).toMatchObject({ state: 'anonymous', actions: { statementPropose: 'denied' } });
  const denied = await send('POST', '/v1/pages:read', { target: { subject: event.id }, languages: ['en'] }, 'outsider');
  expect(denied.body.viewer).toMatchObject({
    state: 'account',
    account: outsider,
    actions: { statementPropose: 'denied' },
  });

  const oldRelease = await send(
    'GET',
    '/v1/definitions/releases/sha256:47c241a4dafea05fc417e1a9881ff634951de64c2a5139551ab2a343d544d673',
    undefined,
    'anonymous',
  );
  expect(oldRelease.response.status).toBe(404);
  await write(`/v1/subjects/${venue.id}:hide`, { reason: 'The admitted venue is withheld.' });
  const hiddenVenue = await send('GET', `/v1/subjects/${venue.id}`, undefined, 'anonymous');
  expect(hiddenVenue.response.status).toBe(404);
  const eventAfterHide = await send(
    'GET',
    `/v1/subjects/${event.id}/relations?property=schema:location&context=${GLOBAL_CONTEXT}&limit=20`,
    undefined,
    'anonymous',
  );
  expect(eventAfterHide.response.status).toBe(200);
  expect(eventAfterHide.body.relations).toEqual([]);
  expect(JSON.stringify(eventAfterHide.body)).not.toContain(venue.id);
});
