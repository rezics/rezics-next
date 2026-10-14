import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { BFF_PREFIX, browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { loadRealmView } from '../../../../../apps/web/features/realm/realm-page.tsx';
import { readFacets, readZoneBrowse, realmFrameReads, type RealmReadClient } from '../../../../../apps/web/features/realm/read.ts';
import { mainBrowseQuery, parseBrowseState } from '../../../../../apps/web/features/zones/browse-state.ts';
import catalogue from '../../../../../scripts/qa/cases/outcomes/visual-novels/catalogue-browse-and-search-in-its-zone.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Page<T> = { items: T[]; nextCursor: string | null; matches: { value: number; kind: string } };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(catalogue);
const works: Work[] = [];
const phrase = `LanternGarden${randomUUID().replaceAll('-', '')}`;
let excluded: Work;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Setup exceptions stay in beforeAll: a failed fixture is never an expected product failure.
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();
  const owner = sessions.owner,
    actor = owner.actingSubject;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  const initial = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`));
  await answer(owner.main('PUT', `${zoneRoot}/configuration`, {
    expectedHead: initial.revision, prepareHomeDocument: true, actingSubject: actor,
  }));
  const prepared = await answer<{ configuration: { homeDocument: string } }>(owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`));
  const homeDocument = prepared.configuration.homeDocument;
  expect(homeDocument).toBeString();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const home = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
      document: fromPlainText(`Original visual novel catalogue and stories by the fixture owner Person (${actor}).`, 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
    }), 201,
  );
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Catalogue editors', permissions: ['publication.adopt'] },
    {
      kind: 'assignment',
      roleId,
      member: actor,
      assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ]) {
    const roles = await answer<{ generation: string }>(
      owner.main('GET', `${root}/roles?${acting(owner)}`),
    );
    const command = {
      actingSubject: actor,
      expectedGeneration: roles.generation,
      reason: 'Adopt the original visual novel fixture catalogue under explicit Realm authority',
      change,
    };
    const preview = await answer<{ digest: string }>(
      owner.main('POST', `${root}/role-impact`, command),
    );
    await answer(
      owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }),
      201,
    );
  }
  for (let index = 0; index < 23; index++) {
    const work = await answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title: `${phrase} ${index}`,
        language: 'en',
        semanticTypes: ['https://schema.org/VideoGame'],
        authoring: 'own-work',
        actingSubject: actor,
      }),
      201,
    );
    if (index === 22) { excluded = work; continue; }
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `${phrase}: An original visual novel in which gardener ${index} chooses a lantern and follows its light.`,
        actingSubject: actor,
      }),
      201,
    );
    const publication = await answer<{ publicationDecision: string }>(
      owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: actor,
      }),
      201,
    );
    const selection = {
      work: work.work,
      contribution: draft.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      actingSubject: actor,
    };
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        ...selection,
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        selectionBasis: 'main-maintainer',
      }),
      201,
    );
    if (index === 21) continue; // Published globally, deliberately outside this Realm catalogue.
    await answer(
      owner.main('POST', '/v1/publication-selections', {
        ...selection,
        profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: sessions.realm },
        mainVersion: work.mainVersion,
        selectionBasis: 'realm-manager-review',
      }),
      201,
    );
    works.push(work);
  }
  const collection = `https://rezics.com/id/${randomUUID()}`;
  const curated = await answer<{ structure: string; revision: string }>(owner.main('POST', '/v1/collections', {
    collection, name: 'Original visual novels', disclosure: 'public', actingSubject: actor,
  }), 201);
  let collectionHead = curated.revision;
  const members = works;
  for (let offset = 0; offset < members.length; offset++) {
    const changed = await answer<{ revision: string }>(owner.main('POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: collectionHead, actingSubject: actor,
      operations: members.slice(offset, offset + 1).map(item => ({ op: 'insert', parent: curated.structure,
        position: 'last', role: 'member', target: item.work, selection: { mode: 'follow-context' } })),
    }));
    collectionHead = changed.revision;
  }
  const zone = await answer<{ revision: string }>(owner.main('GET', `/v1/zones/${short(sessions.zone)}?${acting(owner)}`));
  const mounted = await answer<{ revision: string }>(owner.main('POST', `/v1/zones/${short(sessions.zone)}/mounts`, {
    expectedHead: zone.revision, collection, routeSegment: 'catalogue', disclosure: 'public', position: 'last', actingSubject: actor,
  }));
  expect(mounted.revision).toBeString();
  const configuration = await answer<{ revision: string }>(owner.main('GET', `/v1/zones/${short(sessions.zone)}/configuration?${acting(owner)}`));
  await answer(owner.main('POST', `/v1/zones/${short(sessions.zone)}/site-publications`, {
    expectedHead: configuration.revision, routesRevision: mounted.revision, navigationRevision: mounted.revision,
    pages: [{ page: homeDocument, variantId, revisionId: home.revisionId, byteDigest: home.byteDigest,
      contentEpoch: home.sourcePosition.dataEpoch }], actingSubject: actor,
  }), 201);
}, 240_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

// Stable route labels keep repeated reads and saves distinct without recording fixture setup.
const sampleCounts = new Map<string, number>();
function proofSession(name: PersonaName, session = sessions[name], device = 'primary'): PersonaSession {
  const sample = recording.session(name, session);
  return { ...session, main: (method, path, ...args) => {
    const route = path.split('?')[0]!.split('/').slice(2)
      .filter(part => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(part)).join('-');
    const label = `${device}-${method.toLowerCase()}-${route}`;
    const key = `${name}:${label}`;
    const index = sampleCounts.get(key) ?? 0;
    sampleCounts.set(key, index + 1);
    return sample(`${label}-${index}`, method, path, ...args);
  } };
}

// The Realm browse frame, release filter and shelf controls read these answers.
async function pageReads(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  await answer(sample('realm-context', 'GET', viewer(`/v1/realms/${short(sessions.realm)}`)));
  await answer(sample('space-address', 'GET', viewer(`/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(sessions.space) })}`)));
  await answer(sample('joining-context', 'GET', `/v1/realms/${short(sessions.realm)}/joining?${acting(person)}`));
  await answer(sample('follow-context', 'GET', `/v1/follows/${short(sessions.realm)}?kind=realm&${acting(person)}`));
  await answer(sample('facet-labels', 'GET', '/v1/facets'));
  await answer(sample('browse-route-fallback', 'GET', viewer(`/v1/zones/${short(sessions.zone)}/routes?path=browse`)), 404);
  const empty = await answer<Page<{ id: string }>>(sample('search-no-match', 'GET', `/v1/realms/${short(sessions.realm)}/modules/browse?${new URLSearchParams({
    sort: 'relevance', limit: '20', type: 'https://schema.org/VideoGame', q: `${phrase}nomatch`,
  })}`));
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBeNull();
  await answer(sample('catalogue-search-no-match', 'GET', `/v1/search/catalogue?${new URLSearchParams({ q: `${phrase}nomatch`, realm: sessions.realm, limit: '10' })}`));
  await answer(sample('release-filter-no-match', 'POST', '/v1/query', {
    context: { realm: sessions.realm }, scope: { kind: 'realm', realm: sessions.realm },
    filter: { all: [{ facet: 'release', where: { all: [
      { facet: 'releaseLanguage', any: ['en'] },
      { facet: 'releaseStatus', any: ['official', 'unofficial'] },
    ] } }] }, sort: 'newest', page: { size: 20 },
  }));
  await answer(sample('platform-access', 'GET', '/v1/me/platform-access'));
  await answer(sample('catalogue-reader-states', 'GET', `/v1/me/work-states?${new URLSearchParams({ actingSubject: person.actingSubject!, works: works.map(work => work.work).join(',') })}`));
}

/** The published site key, which is the Space the browse page resolves. */
let publishedSiteKey: string | undefined;
async function publishedSiteKeyOf(): Promise<string> {
  if (publishedSiteKey) return publishedSiteKey;
  const response = await sessions.visitor.main('GET', `/v1/zones/${short(sessions.zone)}/presentation`);
  const raw = await response.text();
  if (response.status !== 200) throw new Error(`Site presentation: HTTP ${response.status}: ${raw}`);
  const body = JSON.parse(raw) as { address?: { key?: string } };
  if (!body.address?.key) throw new Error('Site presentation has no address key');
  publishedSiteKey = body.address.key;
  return publishedSiteKey;
}

const identityHeaders = new Set(['authorization', 'cookie', 'x-session-key', 'host', 'content-length']);

/** What the production client asked for, named from that request rather than from a hand-built URL. */
function productionLabel(path: string): string {
  const url = new URL(path, 'https://record.invalid');
  const pathname = url.pathname;
  if (pathname.endsWith('/modules/browse')) {
    const q = url.searchParams.get('q');
    const sort = url.searchParams.get('sort');
    const nomatch = q?.endsWith('nomatch') === true;
    const base = nomatch && sort === 'relevance' ? 'page-search-no-match-relevance'
      : nomatch ? 'page-search-no-match'
        : q && sort === 'relevance' ? 'page-search-relevance'
          : q && sort === 'newest' ? 'page-search-newest'
            : q && sort === 'updated' ? 'page-search-updated'
              : q ? 'page-search-default'
                : sort === 'newest' ? 'page-browse-newest'
                  : sort === 'updated' ? 'page-browse-updated'
                    : 'page-browse-default';
    const extra = [...url.searchParams.keys()].some(key => !['q', 'sort', 'cursor'].includes(key));
    return `${extra ? `${base}-shaped` : base}${url.searchParams.has('cursor') ? '-continuation' : ''}`;
  }
  if (pathname === '/v1/addresses/resolve') return 'frame-address';
  if (pathname === '/v1/facets') return 'frame-facets';
  if (pathname === '/v1/me/session-agent') return 'frame-session-agent';
  if (pathname === '/v1/me/person-preferences') return 'frame-person-preferences';
  if (pathname === '/v1/me/platform-access') return 'frame-platform-access';
  if (pathname.endsWith('/member-ban')) return 'frame-member-ban';
  if (pathname.includes('/follows/')) return 'frame-follow';
  if (pathname.endsWith('/joining')) return 'frame-joining';
  if (pathname.endsWith('/presentation')) return url.searchParams.has('after') ? 'frame-presentation-page' : 'frame-presentation';
  if (pathname.endsWith('/routes')) return url.searchParams.has('cursor') ? 'frame-routes-continuation' : 'frame-routes';
  if (pathname.endsWith('/zone')) return 'frame-zone';
  if (/\/v1\/realms\/[0-9a-f-]{36}$/.test(pathname)) return 'frame-realm-header';
  return `frame-${pathname.split('/').filter(Boolean).slice(1).join('-') || 'read'}`;
}

/**
 * The browse page's own readers. Anonymous catalogue reads use the visitor
 * session. The signed-in client carries presentation, routes and the host's
 * session reads. Each label is the request the client actually emitted.
 */
async function recordProductionBrowse(name: PersonaName) {
  const person = sessions[name];
  const key = await publishedSiteKeyOf();
  const counts = new Map<string, number>();
  const clientFor = (caller: PersonaSession) => browserMainApi('https://record.invalid', {
    anonymous: !caller.actingSubject,
    fetcher: (async (input, init) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${BFF_PREFIX}/`)) throw new Error(`Expected the Main browser boundary: ${url.pathname}`);
      const path = url.pathname.slice(BFF_PREFIX.length) + url.search;
      const base = productionLabel(path);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      const label = seen === 0 ? base : `${base}-${seen}`;
      const raw = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, header) => {
        if (!identityHeaders.has(header.toLowerCase())) headers[header] = value;
      });
      return recording.session(name, caller)(label, request.method, path,
        raw ? JSON.parse(raw) as unknown : undefined,
        request.headers.get('idempotency-key') ?? undefined,
        { headers, settle: false });
    }) as typeof fetch,
  });
  const anonymous = clientFor(sessions.visitor);
  const personal = person.actingSubject ? clientFor(person) : anonymous;
  const client: RealmReadClient = {
    main: anonymous,
    personal,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
    signedIn: Boolean(person.actingSubject),
  };
  const view = await loadRealmView(key, 'en', {}, 'site', client);
  if (view.kind !== 'view' || !view.realm.zone) throw new Error(`Browse frame did not resolve for ${name}: ${view.kind}`);
  if (view.pkg?.catalogue || view.pkg?.releaseFilter) {
    throw new Error('Visual novels browse loaded a catalogue package; the plain browse read is not the page query');
  }
  const frames = realmFrameReads({
    main: anonymous,
    personal,
    ...(client.actingSubject ? { actingSubject: client.actingSubject } : {}),
    keepProblem: false,
  });
  const zone = view.realm.zone.id;
  await frames.readZoneRoute(zone, 'browse');
  await readFacets(anonymous);
  const pages: Record<string, string>[] = [
    {},
    { sort: 'newest' },
    { sort: 'updated' },
    { q: phrase },
    { q: phrase, sort: 'relevance' },
    { q: phrase, sort: 'newest' },
    { q: phrase, sort: 'updated' },
    { q: `${phrase}nomatch` },
    { q: `${phrase}nomatch`, sort: 'relevance' },
  ];
  for (const pageOf of pages) {
    let search = pageOf;
    const followed = new Set<string>();
    for (;;) {
      if (search.cursor) await frames.readZoneRoute(zone, 'browse', search.cursor);
      const page = await readZoneBrowse(view.realm.realm, 'en', mainBrowseQuery(parseBrowseState(search)), anonymous);
      const cursor = page.ok ? page.data.nextCursor : null;
      if (!cursor) break;
      if (followed.has(cursor)) throw new Error('Browse continuation repeated a cursor');
      followed.add(cursor);
      search = { ...pageOf, cursor };
    }
  }
}

async function browse(name: PersonaName) {
  if (name === 'member') await pageReads(name);
  await recordProductionBrowse(name);
  const person = proofSession(name);
  const root = `/v1/realms/${short(sessions.realm)}/modules`;
  const searchParams = new URLSearchParams({ q: phrase, realm: sessions.realm, limit: '10' });
  const found: string[] = [];
  let search: { results: Array<{ work: string }>; next: string | null; count: { value: number; precision: string } };
  do {
    const path = `/v1/search/catalogue?${searchParams}`;
    const response = await person.main('GET', path);
    if (response.status !== 200) console.info(JSON.stringify({ row: catalogue.rowId, persona: name,
      request: { method: 'GET', path }, answer: { status: response.status, body: await response.clone().json() } }));
    search = await answer(Promise.resolve(response));
    found.push(...search.results.map(item => item.work));
    if (search.next) searchParams.set('cursor', search.next);
  } while (search.next);
  expect(found.sort()).toEqual(works.map(work => work.work).sort());
  expect(new Set(found).size).toBe(21);
  expect(search.count).toEqual({ value: 21, precision: 'exact' });
  const refused = await answer<{ code: string }>(
    person.main('GET', `${root}/browse?sort=relevance&limit=10&type=https%3A%2F%2Fschema.org%2FVideoGame`),
    400,
  );
  expect(refused.code).toBe('unsupported_query_shape');
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'newest' ? [''] : [phrase]) {
      const params = new URLSearchParams({
        sort,
        limit: '20',
        type: 'https://schema.org/VideoGame',
        ...(q ? { q } : {}),
      });
      const seen: string[] = [];
      let page: Page<{ id: string }>;
      do {
        page = await answer<Page<{ id: string }>>(person.main('GET', `${root}/browse?${params}`));
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen.length).toBe(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual(works.map((work) => work.work).sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
    }
  }
  const first = await answer<Page<{ id: string }>>(
    person.main('GET', `${root}/new-adoptions?limit=20`),
  );
  expect(first.nextCursor).not.toBeNull();
  const second = await answer<Page<{ id: string }>>(
    person.main(
      'GET',
      `${root}/new-adoptions?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ),
  );
  expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
    works.map((work) => work.work).sort(),
  );
  expect(second.nextCursor).toBeNull();
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  expect(await answer(person.main('GET', `${zoneRoot}/presentation?${acting(person)}`))).toMatchObject({ zone: sessions.zone, realm: sessions.realm });
  const params = new URLSearchParams({ path: '/catalogue', ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}) });
  const routed: string[] = [];
  let route: Page<{ id: string }>;
  do {
    route = await answer(person.main('GET', `${zoneRoot}/routes?${params}`));
    routed.push(...route.items.map(item => item.id));
    if (route.nextCursor) params.set('cursor', route.nextCursor);
  } while (route.nextCursor);
  expect(routed.sort()).toEqual(works.map(work => work.work).sort());
  await answer(person.main('GET', `${zoneRoot}/routes?path=/catalogue/${short(excluded.work)}&${acting(person)}`), 404);
  expect(await answer(person.main('GET', `${zoneRoot}/routes?path=/catalogue/${short(works[0]!.work)}&${acting(person)}`))).toMatchObject({ kind: 'detail', resource: { id: works[0]!.work } });
  const credits = await answer<{ items: Array<{ agent: string; role: string }> }>(person.main('GET', `/v1/works/${short(works[0]!.work)}/credits?${acting(person)}`));
  expect(credits.items).toContainEqual(expect.objectContaining({ agent: sessions.owner.actingSubject, role: 'author' }));
}

outcomeTest(catalogue, 'visitor', () => browse('visitor'), recording);
outcomeTest(catalogue, 'stranger', () => browse('stranger'), recording);
outcomeTest(catalogue, 'member', () => browse('member'), recording);
outcomeTest(catalogue, 'owner', () => browse('owner'), recording);
outcomeTest(catalogue, 'moderator', () => browse('moderator'), recording);
outcomeTest(catalogue, 'operator', () => browse('operator'), recording);
