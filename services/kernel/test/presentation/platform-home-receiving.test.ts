import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import {
  MAX_PAGE_COST,
  MAX_PAGE_READS,
  planReads,
  platformRegistry,
  profileDigest,
  readCost,
  resolveTemplate,
  type CompositionDocument,
} from '@rezics/composition';
import { platformProfile } from '../../src/presentation/setup.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

type HomeNode = { type: string; props: Record<string, unknown> };
type HomeRecord = CreatedSubject & { type: string; english: string; french: string };
type SearchHit = { id: string; type: string; labels: Record<string, string> };
type SearchPage = { subjects: SearchHit[]; next: string | null };
type PageReadResult = { status: number; body: Record<string, unknown> };
type HomePage = {
  profile: string;
  template: { scope: string; key: string };
  document: CompositionDocument;
  reads: Record<string, PageReadResult>;
};

const languageChain = ['fr', 'en'] as const;
const expectedTypes: Record<string, string[]> = {
  books: ['schema:Book'],
  anime: ['schema:TVSeries', 'schema:Movie'],
  'visual-novels': ['wd:Q689445'],
  recipes: ['schema:Recipe'],
};
const marker = `HomeReceiving${randomUUID().replaceAll('-', '')}`;
let fixture: ReleasedDiscoveryFixture;
let records: Record<string, HomeRecord>;

function homeLists(document: CompositionDocument): HomeNode[] {
  return (document.content as HomeNode[]).filter(({ type }) => type === 'TypeList');
}

async function createHomeRecord(id: string, type: string): Promise<HomeRecord> {
  const english = `${marker} ${id}`;
  const french = `Accueil ${marker} ${id}`;
  const response = await fixture.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type, labels: { en: english, fr: french } },
    discoveryKey(),
  );
  expect(response.status, `${type} native creation: ${JSON.stringify(response.body)}`).toBe(201);
  const subject = response.body.subject as { id: string; release: string; revision: number };
  expect(subject.release).toBe(bundledDigest);
  expect(subject.id).toMatch(/^[0-9a-f-]{36}$/);
  return { id: subject.id, type, release: subject.release, revision: subject.revision, english, french };
}

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  expect(fixture.release.digest).toBe(bundledDigest);
  expect(fixture.release.definition).toEqual(bundledRelease);
  expect(fixture.search).toBeDefined();
  await fixture.setup.openFeatures(['search', 'search_advanced']);

  const definition = await fixture.request('anonymous', 'GET', '/v1/definitions/active');
  expect(definition.status).toBe(200);
  expect(definition.body.digest).toBe(bundledDigest);
  const activeProfile = await fixture.request('anonymous', 'GET', '/v1/presentation/active');
  expect(activeProfile.status).toBe(200);
  expect(activeProfile.body.digest).toBe(profileDigest(platformProfile()));

  records = {
    books: await createHomeRecord('books', 'schema:Book'),
    anime: await createHomeRecord('anime', 'schema:Movie'),
    'visual-novels': await createHomeRecord('visual-novels', 'wd:Q689445'),
    recipes: await createHomeRecord('recipes', 'schema:Recipe'),
  };
  if (!fixture.search) throw new Error('The fixture did not install native Search');
  await fixture.search.converge(Object.values(records));
}, 180_000);

afterAll(async () => {
  if (fixture) await fixture.close();
}, 180_000);

async function observeHome(persona: DiscoveryPersona, hidden?: HomeRecord): Promise<void> {
  const profile = platformProfile();
  const route = resolveTemplate(profile, { route: '/' });
  const document = route.document;
  const plan = planReads(platformRegistry, document, { subject: null });
  const lists = homeLists(document);
  expect(route).toMatchObject({ scope: 'route', key: '/' });
  expect(lists.map(({ props }) => props.id)).toEqual(['books', 'anime', 'visual-novels', 'recipes']);
  expect(Object.keys(plan.reads)).toHaveLength(lists.length);
  expect(Object.keys(plan.reads).length).toBeLessThanOrEqual(MAX_PAGE_READS);
  expect(Object.values(plan.reads).reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(
    MAX_PAGE_COST,
  );

  const response = await fixture.request(
    persona,
    'POST',
    '/v1/pages:read',
    { target: { route: '/' }, languages: [...languageChain] },
  );
  expect(response.status, `${persona} bundled Home: ${JSON.stringify(response.body)}`).toBe(200);
  const page = response.body as unknown as HomePage;
  expect(page).toMatchObject({
    profile: profileDigest(profile),
    template: { scope: 'route', key: '/' },
    document,
  });
  expect(Object.keys(page.reads).sort()).toEqual(Object.values(plan.nodes).sort());

  for (const list of lists) {
    const listId = list.props.id as string;
    const listTypes = list.props.types as string[];
    const listLimit = list.props.limit as number;
    expect(listTypes).toEqual(expectedTypes[listId]!);
    expect(listLimit).toBe(12);
    for (const type of listTypes) expect(bundledRelease.types[type]).toBeDefined();

    const key = plan.nodes[listId]!;
    const descriptor = plan.reads[key]!;
    expect(descriptor.kind).toBe('search');
    if (descriptor.kind !== 'search') throw new Error(`Home node ${listId} did not plan a Search read`);
    expect(descriptor.body).toMatchObject({
      filter: { type: { in: listTypes } },
      sort: 'collections',
      limit: listLimit,
    });
    expect(() => admitFilter(parseFilter(descriptor.body.filter), bundledRelease)).not.toThrow();

    const aggregate = page.reads[key]!;
    expect(aggregate.status, `${persona} Home ${listId}: ${JSON.stringify(aggregate.body)}`).toBe(200);
    const aggregatePage = aggregate.body as unknown as SearchPage;
    expect(aggregatePage.subjects.length).toBeLessThanOrEqual(listLimit);
    expect(aggregatePage.next).toBeNull();
    for (const hit of aggregatePage.subjects) {
      expect(listTypes).toContain(hit.type);
      expect(bundledRelease.types[hit.type]).toBeDefined();
      expect(Object.keys(hit.labels)).toEqual(['fr']);
    }

    const pageSession = response.headers.get(SESSION_HEADER);
    const standaloneRequest = { ...descriptor.body, languages: [...languageChain] };
    const standalone = await fixture.request(
      persona,
      'POST',
      '/v1/subjects:search',
      standaloneRequest,
      pageSession === null ? undefined : { [SESSION_HEADER]: pageSession },
    );
    expect(standalone.status, `${persona} standalone ${listId}: ${JSON.stringify(standalone.body)}`).toBe(200);
    const standalonePage = standalone.body as unknown as SearchPage;
    expect(standalonePage.subjects).toEqual(aggregatePage.subjects);
    expect(standalonePage.next).toBe(aggregatePage.next);

    const seeded = records[listId]!;
    const seededHit = aggregatePage.subjects.find(({ id }) => id === seeded.id);
    if (hidden?.id === seeded.id) {
      expect(aggregatePage.subjects.map(({ id }) => id)).not.toContain(hidden.id);
      expect(standalonePage.subjects.map(({ id }) => id)).not.toContain(hidden.id);
    } else {
      expect(seededHit, `${persona} Home ${listId} must disclose its public native record`).toBeDefined();
      expect(seededHit).toMatchObject({ id: seeded.id, type: seeded.type, labels: { fr: seeded.french } });
    }
  }
}

test('the bundled Home lists use installed native Search with standalone disclosure for anonymous and member readers', async () => {
  for (const persona of ['anonymous', 'alice'] as const) await observeHome(persona);

  const hidden = records.books!;
  if (!fixture.search) throw new Error('The fixture did not install native Search');
  await fixture.search.indexing('paused');
  await fixture.grant('editor', ['moderation:hide'], GLOBAL_CONTEXT);
  const concealed = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${hidden.id}:hide`,
    { reason: 'Current Home disclosure receiving case' },
    discoveryKey(),
  );
  expect(concealed.status, JSON.stringify(concealed.body)).toBe(200);
  const standalone = await fixture.request('anonymous', 'GET', `/v1/subjects/${hidden.id}`);
  expect(standalone.status).toBe(404);

  for (const persona of ['anonymous', 'alice'] as const) await observeHome(persona, hidden);
}, 180_000);
