import { afterAll, describe, expect, test } from 'bun:test';
import {
  PROFILE_FORMAT,
  UI_LOCALES,
  type CompositionDocument,
  type MemberSource,
  type PresentationProfile,
} from '@rezics/composition';
import type { FilterDocument } from '@rezics/filter';
import type { HttpResponse } from '../../../../specs/semantic-driver';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions';
import { discoveryKey, type DiscoveryPersona } from '../support/released-discovery';
import {
  createReleasedLibraryPopulation,
  type ReleasedLibraryPopulation,
} from '../library/support/released-library-population';

// One existing shared native population and its original transport, worker and cleanup own every surface.
let population: Promise<ReleasedLibraryPopulation> | undefined;
function world() {
  return (population ??= createReleasedLibraryPopulation({ version: 1, search: 'native' }));
}
afterAll(async () => {
  if (population) await (await population).close();
});
function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response;
}
const jobs = ['words', 'formHarem', 'combined', 'dietTime'] as const;
type Job = (typeof jobs)[number];
let catalogue: Promise<Awaited<ReturnType<typeof prepare>>> | undefined;
async function prepare() {
  const f = await world();
  await f.base.setup.openFeatures(['personal_library', 'reading_progress']);
  const classification = await f.base.classification();
  const diet = await f.base.diet();
  const books = await f.base.books();
  const recipes = await f.base.recipes();
  const filters = f.base.filters(classification, diet);
  const expected = {
    words: [books.subjects['B-long'].id],
    formHarem: ['B-long', 'B-edge', 'B-short'].map((name) => books.subjects[name as keyof typeof books.subjects].id),
    combined: [books.subjects['B-long'].id],
    dietTime: ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked'].map(
      (name) => recipes.subjects[name as keyof typeof recipes.subjects].id,
    ),
  } satisfies Record<Job, string[]>;
  const subjects = [...Object.values(books.subjects), ...Object.values(recipes.subjects)];
  const created = status(
    await f.request(
      'alice',
      'POST',
      '/v1/collections',
      { title: 'Released discovery', visibility: 'public' },
      discoveryKey(),
    ),
    201,
  );
  const curated = created.body.collection as { id: string };
  for (const subject of subjects)
    status(
      await f.request(
        'alice',
        'POST',
        `/v1/collections/${curated.id}/members`,
        { subjectId: subject.id, note: 'Original occurrence' },
        discoveryKey(),
      ),
      201,
    );
  status(
    await f.request(
      'alice',
      'POST',
      `/v1/collections/${curated.id}/members`,
      { subjectId: books.subjects['B-long'].id, note: 'Independent duplicate note' },
      discoveryKey(),
    ),
    201,
  );
  const labelResponse = status(
    await f.request('alice', 'POST', '/v1/libraryLabels', { name: 'Discovery support' }, discoveryKey()),
    201,
  );
  const label = labelResponse.body.label as { id: string };
  for (const subject of subjects)
    status(
      await f.request(
        'alice',
        'POST',
        `/v1/libraryLabels/${label.id}:assign`,
        { subjectId: subject.id },
        discoveryKey(),
      ),
      200,
    );
  await f.base.catchUp(subjects);
  return { f, subjects, books, recipes, filters, expected, curated };
}
const data = () => (catalogue ??= prepare());
function memberDocument(source: MemberSource, filter: FilterDocument, id = 'members'): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'Members',
        props: { id, title: 'Discovery', source, filter: JSON.stringify(filter), limit: 2, paged: true },
      },
    ],
  };
}
function typeDocument(job: Job, filter: FilterDocument): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'TypeList',
        props: {
          id: 'results',
          title: 'Discovery',
          types: [job === 'dietTime' ? 'schema:Recipe' : 'schema:Book'],
          filter: JSON.stringify(filter),
          sort: 'name',
          limit: 2,
          paged: true,
        },
      },
    ],
  };
}
async function configure(document: CompositionDocument) {
  const { f } = await data();
  await f.base.grant('editor', ['presentation:publish', 'presentation:activate'], GLOBAL_CONTEXT);
  const profile: PresentationProfile = {
    format: PROFILE_FORMAT,
    generic: { root: { props: {} }, content: [] },
    bases: [],
    types: [],
    routes: [{ route: '/discovery', document }],
  };
  const published = await f.request('editor', 'POST', '/v1/presentation/profiles', { profile }, discoveryKey());
  expect([200, 201], JSON.stringify(published.body)).toContain(published.status);
  const digest = published.body.digest as string;
  const active = await f.request('editor', 'GET', '/v1/presentation/active');
  if (active.status === 404) expect(active.body.code).toBe('not_found');
  else status(active, 200);
  status(
    await f.request(
      'editor',
      'POST',
      `/v1/presentation/profiles/${digest}:activate`,
      { expected_head: active.status === 404 ? null : active.body.head },
      discoveryKey(),
    ),
    200,
  );
}
async function builtin(kind: 'everything' | 'state', type = 'schema:Book', persona: 'alice' | 'bob' = 'alice') {
  const { f } = await data();
  const profile = f.profile(type).profile;
  const set = profile.entryStateSet!;
  const state = set.states.find((value) => value.role === (persona === 'alice' ? 'active' : 'completed'))!;
  const response = status(
    await f.request(
      persona,
      'GET',
      `/v1/collections?${new URLSearchParams({ curatorAccountId: f.base.personas[persona].accountId, view: 'FULL', limit: '100' })}`,
    ),
    200,
  );
  const collections = response.body.collections as {
    id: string;
    builtin?: { kind: string; profileId?: string; stateSetId?: string; stateId?: string };
  }[];
  const found = collections.find(
    (value) =>
      value.builtin?.kind === kind &&
      (kind === 'everything' ||
        (value.builtin.profileId === profile.id &&
          value.builtin.stateSetId === set.id &&
          value.builtin.stateId === state.id)),
  );
  expect(found, 'Native discovery must provide the built-in identity').toBeDefined();
  return found!;
}
let statesReady: Promise<void> | undefined;
async function states() {
  return (statesReady ??= (async () => {
    const { f, subjects, recipes } = await data();
    for (const subject of subjects) {
      const type = Object.values(recipes.subjects).some((value) => value.id === subject.id)
        ? 'schema:Recipe'
        : 'schema:Book';
      const set = f.profile(type).profile.entryStateSet!;
      const active = set.states.find((value) => value.role === 'active')!;
      const completed = set.states.find((value) => value.role === 'completed')!;
      status(
        await f.request('alice', 'PUT', `/v1/libraryEntries/${subject.id}`, { state: active.id }, discoveryKey()),
        201,
      );
      status(
        await f.request('bob', 'PUT', `/v1/libraryEntries/${subject.id}`, { state: completed.id }, discoveryKey()),
        201,
      );
    }
    await f.base.catchUp(subjects);
  })());
}
async function members(id: string, filter: FilterDocument, persona: DiscoveryPersona, expected: string[]) {
  const { f } = await data();
  let cursor: string | undefined;
  const ids: string[] = [];
  const cursors = new Set<string>();
  let preparing = 0;
  for (let page = 0; page < 32; page++) {
    const query = new URLSearchParams({
      filter: JSON.stringify(filter),
      sort: 'id',
      view: 'FULL',
      limit: '2',
      ...(cursor ? { cursor } : {}),
    });
    const response = await f.request(persona, 'GET', `/v1/collections/${id}/members?${query}`);
    if (response.status === 202) {
      expect(response.body).toEqual({ preparing: true });
      expect(response.headers.get('retry-after')).toBe('1');
      expect(++preparing).toBeLessThan(16);
      await Bun.sleep(100);
      continue;
    }
    status(response, 200);
    const rows = response.body.members as { subjectId: string; subject: unknown }[];
    expect(rows.length).toBeLessThanOrEqual(2);
    for (const row of rows) {
      expect(row.subject).toBeDefined();
      ids.push(row.subjectId);
    }
    if (response.body.next === null) {
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([...expected].sort());
      return;
    }
    expect(rows).toHaveLength(2);
    expect(typeof response.body.next).toBe('string');
    cursor = response.body.next as string;
    expect(cursors.has(cursor)).toBe(false);
    cursors.add(cursor);
  }
  throw new Error('Native common-members did not reach genuine final exhaustion');
}
async function pageResults(
  path: string,
  target: object,
  node: string,
  persona: DiscoveryPersona,
  expected: string[],
  zone = false,
) {
  const { f } = await data();
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 32; page++) {
    const response = await f.request(
      persona,
      'POST',
      zone && cursor ? `${path}?${new URLSearchParams({ cursor })}` : path,
      { target, languages: ['en'], ...(!zone && cursor ? { continuation: { node, cursor } } : {}) },
    );
    if (zone && response.status === 202) {
      expect(typeof response.body.next).toBe('string');
      cursor = response.body.next as string;
      continue;
    }
    status(response, 200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const results = response.body.reads as Record<
      string,
      { status: number; body: Record<string, unknown>; headers?: Record<string, string> }
    >;
    const result = Object.values(results).find((value) => value.status !== 204)!;
    if (result.status === 202) {
      expect(result.body).toEqual({ preparing: true });
      expect(result.headers?.['retry-after']).toBe('1');
      await Bun.sleep(100);
      continue;
    }
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const rows = (result.body.members ?? result.body.subjects) as { subjectId?: string; id?: string }[];
    expect(rows.length).toBeLessThanOrEqual(2);
    ids.push(...rows.map((value) => value.subjectId ?? value.id!));
    if (result.body.next === null) {
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...expected].sort());
      return;
    }
    expect(rows).toHaveLength(2);
    expect(typeof result.body.next).toBe('string');
    expect(result.body.next).not.toBe(cursor);
    cursor = result.body.next as string;
  }
  throw new Error('Native composed page did not reach genuine final exhaustion');
}

describe('the same released predicates agree across curated Everything without state own state mounted Zone and configured TypeList', () => {
  for (const surface of [
    'curated',
    'Everything without state',
    'own state',
    'mounted Zone',
    'configured TypeList',
  ] as const) {
    for (const job of jobs)
      test(`${job} agrees across ${surface}`, async () => {
        const { f, filters, expected, curated } = await data();
        if (surface === 'curated') {
          await members(curated.id, filters[job], 'anonymous', expected[job]);
          await members(curated.id, filters[job], 'editor', expected[job]);
        } else if (surface === 'Everything without state') {
          const source = await builtin('everything');
          await members(source.id, filters[job], 'alice', expected[job]);
          for (const persona of ['bob', 'anonymous'] as const)
            status(await f.request(persona, 'GET', `/v1/collections/${source.id}/members`), 404);
        } else if (surface === 'own state') {
          await states();
          const source = await builtin('state', job === 'dietTime' ? 'schema:Recipe' : 'schema:Book');
          await members(source.id, filters[job], 'alice', expected[job]);
          const bob = await builtin('state', job === 'dietTime' ? 'schema:Recipe' : 'schema:Book', 'bob');
          expect(bob.id).not.toBe(source.id);
          await members(bob.id, filters[job], 'bob', expected[job]);
          status(await f.request('alice', 'GET', `/v1/collections/${bob.id}/members`), 404);
          for (const persona of ['bob', 'anonymous'] as const)
            status(await f.request(persona, 'GET', `/v1/collections/${source.id}/members`), 404);
        } else if (surface === 'configured TypeList') {
          await configure(typeDocument(job, filters[job]));
          await pageResults('/v1/pages:read', { route: '/discovery' }, 'results', 'anonymous', expected[job]);
          await pageResults('/v1/pages:read', { route: '/discovery' }, 'results', 'editor', expected[job]);
        } else {
          await f.base.grant('editor', ['zone:create'], GLOBAL_CONTEXT);
          const input = {
            configuration: {
              labels: Object.fromEntries(UI_LOCALES.map((locale) => [locale, 'Discovery'])),
              scope: [job === 'dietTime' ? 'recipe/all' : 'book/all'],
              pages: [{ route: '', document: typeDocument(job, filters[job]) }],
            },
            mounts: [curated.id],
            visibility: 'public',
          };
          const created = status(await f.request('editor', 'POST', '/v1/zones', input, discoveryKey()), 201);
          const zone = created.body.zone as { id: string; revision: string };
          status(
            await f.request(
              'editor',
              'POST',
              `/v1/zones/${zone.id}:publish`,
              { visibility: 'public' },
              { ...discoveryKey(), 'if-match': `"${zone.revision}"` },
            ),
            200,
          );
          await pageResults(
            `/v1/zones/${zone.id}:readPage`,
            { route: '' },
            'results',
            'anonymous',
            expected[job],
            true,
          );
          await pageResults(`/v1/zones/${zone.id}:readPage`, { route: '' }, 'results', 'editor', expected[job], true);
        }
      }, 120_000);
  }
});

test('Compose native Members Everything and own-state page reads end to end', async () => {
  const { f, filters, expected, curated } = await data();
  await states();
  const state = (await builtin('state')).builtin!;
  const sources: MemberSource[] = [
    { kind: 'collection', id: curated.id },
    { kind: 'everything' },
    { kind: 'state', profileId: state.profileId!, stateSetId: state.stateSetId!, stateId: state.stateId! },
  ];
  for (const source of sources) {
    await configure(memberDocument(source, filters.formHarem));
    await pageResults('/v1/pages:read', { route: '/discovery' }, 'members', 'alice', expected.formHarem);
    if (source.kind !== 'collection') {
      const anonymous = status(
        await f.request('anonymous', 'POST', '/v1/pages:read', { target: { route: '/discovery' } }),
        200,
      );
      expect(
        Object.values(anonymous.body.reads as Record<string, { status: number }>).map((value) => value.status),
      ).toEqual([404]);
    }
  }
  const suspended = await f.request('suspended', 'POST', '/v1/pages:read', { target: { route: '/discovery' } });
  status(suspended, 401);
  expect(suspended.body.code).toBe('invalid_credentials');
  expect(suspended.headers.get('www-authenticate')).toContain('invalid_token');
}, 120_000);
