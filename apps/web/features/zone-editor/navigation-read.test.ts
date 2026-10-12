import { describe, expect, test } from 'vitest';
import {
  browserZoneCollectionLookup, browserZoneNavigation, loadCompleteZoneNavigation, loadZoneNavigation, readCompleteZoneNavigation,
  type NavigationResume, type NavigationSnapshot, type WriteResult, type ZoneNavigationClient,
} from './api.ts';
import { NAV_LOAD_BATCH, NAV_PAGE_SIZE, type SiteLink } from './navigation.ts';

const zoneId = '00000000-0000-4000-8000-000000000701';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000702';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000703';
const navigationRevision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000704';
const navigationId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000705';
const changedHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000706';
const heads = { zoneHead, navigationRevision };
const iri = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

type Answer = { data: unknown; error: { status: number; value: unknown } | null };
type Query = { actingSubject: string; after?: string; limit: number };
type PageRequest = { revision: string | null; query: Query };

function page(index: number, count: number, mounts = 1) {
  return { revision: navigationRevision, navigation: navigationId, ownerRevision: zoneHead,
    mounts: Array.from({ length: mounts }, (_, offset) => {
      const ordinal = index * mounts + offset + 1;
      return { occurrence: iri(1000 + ordinal), target: iri(100000 + ordinal), role: 'mount', state: 'active',
        labels: [`Saved shelf ${ordinal}`],
        qualifier: { type: 'zone-mount', routeSegment: `shelf-${ordinal}`, disclosure: 'public' } };
    }), next: index + 1 < count ? `cursor-${index + 1}` : null };
}

function fakeMain(read: (request: PageRequest) => Answer) {
  const calls: PageRequest[] = [];
  const nameActors: string[] = [];
  let collectionNames = 0;
  const get = async (revision: string | null, { query }: { query: Query }) => {
    const request = { revision, query };
    calls.push(request);
    return read(request);
  };
  const main = { v1: {
    zones: ({ id }: { id: string }) => {
      expect(id).toBe(zoneId);
      return { get: (options: { query: Query }) => get(null, options),
        revisions: ({ revision }: { revision: string }) => ({ get: (options: { query: Query }) => get(revision, options) }) };
    },
    collections: () => ({ name: { get: async () => {
      collectionNames += 1;
      return { data: null, error: { status: 404, value: {} } };
    } } }),
    works: () => ({ get: async ({ query }: { query: { actingSubject: string } }) => {
      nameActors.push(query.actingSubject);
      return { data: null, error: { status: 403, value: {} } };
    } }),
  } };
  return { main: main as never, calls, nameActors, collectionNames: () => collectionNames };
}

const pageIndex = ({ query }: PageRequest) => query.after ? Number(query.after.slice('cursor-'.length)) : 0;

describe('Collection resource-link lookup', () => {
  const collection = iri(900);
  function lookup(identity: Answer, named: Answer = { data: { collection, name: 'Harbor charts' }, error: null }) {
    const identityCalls: unknown[] = [];
    const nameCalls: string[] = [];
    const main = { v1: { collections: ({ id }: { id: string }) => ({
      get: async (options: unknown) => { identityCalls.push({ id, options }); return identity; },
      name: { get: async () => { nameCalls.push(id); return named; } },
    }) } };
    return { api: browserZoneCollectionLookup(main as never), identityCalls, nameCalls };
  }

  test('uses an authorized Collection identity and its actual public name without Work typeahead', async () => {
    const fake = lookup({ data: { collection, structure: iri(901), revision: iri(902) }, error: null },
      { data: { collection, name: { original: 'en', labels: { en: 'Harbor charts' } } }, error: null });
    expect(await fake.api.findCollection(` ${collection} `, actor)).toEqual({ ok: true,
      data: { target: collection, name: 'Harbor charts' } });
    expect(fake.identityCalls).toEqual([{ id: collection.slice(-36), options: { query: { actingSubject: actor, limit: 1 } } }]);
    expect(fake.nameCalls).toEqual([collection.slice(-36)]);
  });

  test.each([
    { status: 401, failure: 'sign-in' },
    { status: 403, failure: 'denied' },
    { status: 404, failure: 'denied' },
    { status: 503, failure: 'unavailable' },
  ])('preserves Collection identity failure ($failure) without reading names', async ({ status, failure }) => {
    const fake = lookup({ data: null, error: { status, value: {} } });
    expect(await fake.api.findCollection(collection, actor)).toEqual({ ok: false, failure });
    expect(fake.nameCalls).toEqual([]);
  });

  test.each(['Harbor charts', 'https://example.com/id/00000000-0000-4000-8000-000000000900'])
    ('rejects an invalid resource link before any read (%s)', async link => {
      const fake = lookup({ data: { collection }, error: null });
      expect(await fake.api.findCollection(link, actor)).toEqual({ ok: false, failure: 'invalid' });
      expect(fake.identityCalls).toEqual([]);
    });

  test('refuses a name returned for another identity', async () => {
    const fake = lookup({ data: { collection }, error: null },
      { data: { collection: iri(999), name: 'Another shelf' }, error: null });
    expect(await fake.api.findCollection(collection, actor)).toEqual({ ok: false, failure: 'unavailable' });
  });

  test('retains failure when the Collection is readable but its public name is unavailable', async () => {
    const fake = lookup({ data: { collection }, error: null }, { data: null, error: { status: 503, value: {} } });
    expect(await fake.api.findCollection(collection, actor)).toEqual({ ok: false, failure: 'unavailable' });
  });
});

describe('page suggestion outcomes', () => {
  const work = iri(910);
  const item = { work, matchedField: 'title', title: { value: 'Harbor charts' } };
  function suggestions(answer: Answer | Error) {
    const queries: unknown[] = [];
    const main = { v1: { search: { typeahead: { get: async (options: unknown) => {
      queries.push(options);
      if (answer instanceof Error) throw answer;
      return answer;
    } } } } };
    return { api: browserZoneNavigation(main as never), queries };
  }

  test('retains hasMore and the selected Works rather than calling a bounded page complete', async () => {
    const fake = suggestions({ data: { items: [item], hasMore: true }, error: null });
    expect(await fake.api.findPages('Harbor', 'en')).toEqual({ ok: true,
      data: { choices: [{ target: work, name: 'Harbor charts' }], hasMore: true } });
    expect(fake.queries).toEqual([{ query: { prefix: 'Harbor', language: 'en' } }]);
  });

  test('a successful empty terminal result remains distinct from failure', async () => {
    const fake = suggestions({ data: { items: [], hasMore: false }, error: null });
    expect(await fake.api.findPages('Harbor', 'en')).toEqual({ ok: true, data: { choices: [], hasMore: false } });
  });

  test.each([
    { status: 401, failure: 'sign-in' },
    { status: 403, failure: 'denied' },
    { status: 503, failure: 'unavailable' },
  ])('preserves suggestion read refusal ($failure)', async ({ status, failure }) => {
    const fake = suggestions({ data: null, error: { status, value: {} } });
    expect(await fake.api.findPages('Harbor', 'en')).toEqual({ ok: false, failure });
  });

  test('a thrown read remains unavailable', async () => {
    const fake = suggestions(new Error('Connection lost'));
    expect(await fake.api.findPages('Harbor', 'en')).toEqual({ ok: false, failure: 'unavailable' });
  });

  test.each([
    { items: [item] },
    { items: [item], hasMore: false, complete: false },
    { items: [item], hasMore: false, partial: true },
    { items: [item, { matchedField: 'title', work }], hasMore: false },
  ])('retains partial source failure instead of showing ready suggestions (%j)', async data => {
    const fake = suggestions({ data, error: null });
    expect(await fake.api.findPages('Harbor', 'en')).toEqual({ ok: false, failure: 'partial' });
  });
});

describe('complete authorized preview navigation', () => {
  test('an empty saved navigation is a complete inventory', async () => {
    const fake = fakeMain(() => ({ data: page(0, 1, 0), error: null }));
    expect(await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads)).toEqual({ ok: true, data: {
      head: navigationRevision, navigation: navigationId, zoneHead, links: [], complete: true, after: null,
    } });
    expect(fake.collectionNames()).toBe(0);
    expect(fake.nameActors).toEqual([]);
  });

  test('continues beyond a filled burst and retains every saved mount when public names are unavailable', async () => {
    const count = NAV_LOAD_BATCH + 2;
    const fake = fakeMain(request => ({ data: page(pageIndex(request), count, NAV_PAGE_SIZE), error: null }));
    const result = await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.failure);
    expect(result.data).toMatchObject({ head: navigationRevision, navigation: navigationId, zoneHead,
      complete: true, after: null });
    expect(result.data.links).toHaveLength(count * NAV_PAGE_SIZE);
    expect(result.data.links.map(link => link.segment)).toEqual(
      Array.from({ length: count * NAV_PAGE_SIZE }, (_, index) => `shelf-${index + 1}`),
    );
    expect(result.data.links.at(-1)?.name).toBe(`Saved shelf ${count * NAV_PAGE_SIZE}`);
    expect(fake.calls).toHaveLength(count);
    expect(fake.calls[0]).toEqual({ revision: null, query: { actingSubject: actor, limit: NAV_PAGE_SIZE } });
    expect(fake.calls.slice(1)).toEqual(Array.from({ length: count - 1 }, (_, index) => ({
      // ast-grep-ignore: no-cursor-arithmetic -- Independent expected tokens verify the consumer forwards the fixture owner's continuation.
      revision: navigationRevision.slice(-36), query: { actingSubject: actor, limit: NAV_PAGE_SIZE, after: `cursor-${index + 1}` },
    })));
    expect(fake.collectionNames()).toBe(count * NAV_PAGE_SIZE);
    expect(fake.nameActors).toEqual(Array(count * NAV_PAGE_SIZE).fill(actor));
  });

  test('the editor burst still exposes a cursor rather than claiming completion', async () => {
    const fake = fakeMain(request => ({ data: page(pageIndex(request), NAV_LOAD_BATCH + 1), error: null }));
    const result = await loadZoneNavigation(fake.main, zoneId, actor);
    // ast-grep-ignore: no-cursor-arithmetic -- Independent expected token verifies the editor exposes the fixture owner's unfinished continuation.
    expect(result).toMatchObject({ ok: true, data: { complete: false, after: `cursor-${NAV_LOAD_BATCH}` } });
    expect(fake.calls).toHaveLength(NAV_LOAD_BATCH);
  });

  test.each([
    { ownerRevision: changedHead },
    { ownerRevision: null },
    { revision: changedHead },
  ])('fails explicitly when the first read does not match the saved preview (%j)', async mismatch => {
    const fake = fakeMain(() => ({ data: { ...page(0, 1), ...mismatch }, error: null }));
    expect(await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads)).toEqual({ ok: false, failure: 'moved' });
  });

  test.each([
    { ownerRevision: changedHead },
    { ownerRevision: null },
    { revision: changedHead },
    { navigation: changedHead },
  ])('does not combine changed heads within a burst (%j)', async mismatch => {
    const fake = fakeMain(request => ({ data: { ...page(pageIndex(request), 2), ...(request.query.after ? mismatch : {}) }, error: null }));
    expect(await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads)).toEqual({ ok: false, failure: 'moved' });
    expect(fake.calls).toHaveLength(2);
  });

  test.each([
    { ownerRevision: changedHead },
    { revision: changedHead },
    { navigation: changedHead },
  ])('does not combine changed heads across bursts (%j)', async mismatch => {
    const fake = fakeMain(request => {
      const index = pageIndex(request);
      return { data: { ...page(index, NAV_LOAD_BATCH + 1), ...(index >= NAV_LOAD_BATCH ? mismatch : {}) }, error: null };
    });
    expect(await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads)).toEqual({ ok: false, failure: 'moved' });
    expect(fake.calls).toHaveLength(NAV_LOAD_BATCH + 1);
  });

  test.each([
    { status: 403, failure: 'denied' },
    { status: 404, failure: 'denied' },
    { status: 401, failure: 'sign-in' },
    { status: 409, failure: 'moved' },
    { status: 422, failure: 'budget' },
  ])('preserves a continuation refusal and does not retry a moved cursor ($failure)', async ({ status, failure }) => {
    const fake = fakeMain(request => request.query.after
      ? { data: null, error: { status, value: {} } }
      : { data: page(0, 2), error: null });
    expect(await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads)).toEqual({ ok: false, failure });
    expect(fake.calls).toHaveLength(2);
  });

  test('refuses a cursor cycle inside a burst before displaying a partial inventory', async () => {
    const fake = fakeMain(request => ({ data: { ...page(pageIndex(request), 3),
      next: request.query.after === 'cursor-2' ? 'cursor-1' : page(pageIndex(request), 3).next }, error: null }));
    expect(await loadCompleteZoneNavigation(fake.main, zoneId, actor, heads)).toEqual({ ok: false, failure: 'unavailable' });
    expect(fake.calls).toHaveLength(3);
  });

  test('browser reads report an owner change as stale with its current head', async () => {
    const fake = fakeMain(request => ({ data: { ...page(pageIndex(request), 2),
      ...(request.query.after ? { ownerRevision: changedHead } : {}) }, error: null }));
    expect(await browserZoneNavigation(fake.main).readNavigation(zoneId, actor))
      .toEqual({ ok: false, failure: 'stale', currentHead: changedHead });
  });
});

describe('complete saved publication navigation', () => {
  function link(index: number): SiteLink {
    return { id: String(index), occurrence: iri(2000 + index), target: iri(3000 + index),
      name: `Saved shelf ${index}`, segment: `shelf-${index}`, disclosure: 'public' };
  }

  function snapshots(answers: Array<WriteResult<NavigationSnapshot>>) {
    const calls: Array<{ zone: string; actor: string; resume?: NavigationResume }> = [];
    let index = 0;
    const next = async (zone: string, actingSubject: string, resume?: NavigationResume) => {
      calls.push({ zone, actor: actingSubject, ...(resume ? { resume } : {}) });
      return answers[index++] ?? { ok: false as const, failure: 'unavailable' as const };
    };
    const client: Pick<ZoneNavigationClient, 'readNavigation' | 'continueNavigation'> = {
      readNavigation: (zone, actingSubject) => next(zone, actingSubject),
      continueNavigation: next,
    };
    return { client, calls };
  }

  const snapshot: NavigationSnapshot = { head: navigationRevision, navigation: navigationId,
    zoneHead, links: [link(1)], complete: false, after: 'next-1' };

  test('reads every saved burst in order under the same actor and revision', async () => {
    const fake = snapshots([
      { ok: true, data: snapshot },
      { ok: true, data: { ...snapshot, links: [link(2)], after: 'next-2' } },
      { ok: true, data: { ...snapshot, links: [link(3)], complete: true, after: null } },
    ]);
    expect(await readCompleteZoneNavigation(zoneId, actor, fake.client)).toEqual({ ok: true, data: {
      ...snapshot, links: [link(1), link(2), link(3)], complete: true, after: null,
    } });
    expect(fake.calls).toEqual([
      { zone: zoneId, actor },
      { zone: zoneId, actor, resume: { head: navigationRevision, after: 'next-1' } },
      { zone: zoneId, actor, resume: { head: navigationRevision, after: 'next-2' } },
    ]);
  });

  test.each([
    { ...snapshot, after: null },
    { ...snapshot, complete: true },
  ])('rejects a result with contradictory completion metadata (%j)', async data => {
    const fake = snapshots([{ ok: true, data }]);
    expect(await readCompleteZoneNavigation(zoneId, actor, fake.client)).toEqual({ ok: false, failure: 'unavailable' });
    expect(fake.calls).toHaveLength(1);
  });

  test('refuses a repeated continuation cursor between bursts', async () => {
    const fake = snapshots([{ ok: true, data: snapshot }, { ok: true, data: snapshot }]);
    expect(await readCompleteZoneNavigation(zoneId, actor, fake.client)).toEqual({ ok: false, failure: 'unavailable' });
    expect(fake.calls).toHaveLength(2);
  });

  test.each([
    { ...snapshot, head: changedHead },
    { ...snapshot, navigation: changedHead },
    { ...snapshot, zoneHead: changedHead },
    { ...snapshot, zoneHead: null },
  ])('refuses mixed saved heads between browser bursts (%j)', async data => {
    const fake = snapshots([{ ok: true, data: snapshot }, { ok: true, data }]);
    expect(await readCompleteZoneNavigation(zoneId, actor, fake.client))
      .toEqual({ ok: false, failure: 'stale', currentHead: data.zoneHead });
  });

  test.each([
    { ok: false as const, failure: 'denied' as const },
    { ok: false as const, failure: 'sign-in' as const },
    { ok: false as const, failure: 'stale' as const, currentHead: changedHead },
  ])('preserves a browser continuation refusal ($failure)', async refusal => {
    const fake = snapshots([{ ok: true, data: snapshot }, refusal]);
    expect(await readCompleteZoneNavigation(zoneId, actor, fake.client)).toEqual(refusal);
    expect(fake.calls).toHaveLength(2);
  });
});
