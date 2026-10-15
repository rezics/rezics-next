import { missingCatalogueStates } from '../../../apps/web/features/zones/catalogue-browse-fixtures.ts';
import { expect } from 'bun:test';
import type { PersonaName, PersonaSession } from './personas.ts';
import type { OutcomeRecorder } from './outcome-test.ts';

/** Keep the story's query and label; only the fixture Realm is allocated by setup. */
export async function recordCatalogueStoryReads(recording: OutcomeRecorder, name: PersonaName,
  person: PersonaSession, realm: string, slug: 'anime' | 'games') {
  const sample = recording.session(name, person);
  for (const request of missingCatalogueStates.filter(request => request.slug === slug
    && (request.state === 'populated' || request.state === 'empty'))) {
    const url = new URL(request.path, 'http://main.local');
    const path = `/v1/realms/${realm.slice(-36)}/modules/browse${url.search}`;
    const response = await sample(request.label, request.method, path);
    const raw = await response.text();
    expect(response.status, `${path}: ${raw}`).toBe(200);
    const page = JSON.parse(raw) as { items: unknown[]; window: { complete: boolean } };
    if (request.state === 'populated') expect(page.items.length).toBeGreaterThan(0);
    else {
      expect(page.items).toEqual([]);
      expect(page.window.complete).toBe(true);
    }
  }
  // Lagging requires control of projection progress; error requires an unavailable
  // dependency; moved requires a changed read generation. Public commands cannot
  // arrange these states, and a fabricated contract cursor is not a continuation.
}

/** The fallback Zone route receives the cursor from this persona's own default page. */
export async function recordZoneBrowseContinuation(recording: OutcomeRecorder, name: PersonaName,
  person: PersonaSession, zone: string, cursor: string | null) {
  if (!cursor) return;
  const params = new URLSearchParams({ path: 'browse', cursor });
  if (person.actingSubject) params.set('actingSubject', person.actingSubject);
  const response = await recording.session(name, person)('page-browse-default-zone-continuation',
    'GET', `/v1/zones/${zone.slice(-36)}/routes?${params}`);
  await response.body?.cancel();
}

/** Record the production browse route and its shared frame, using each session's own credentials. */
export async function recordAnimeCatalogueVisits(recording: OutcomeRecorder, name: PersonaName,
  sessions: { visitor: PersonaSession; realm: string; zone: string } & Record<PersonaName, PersonaSession>,
  phrase: string, format: string) {
  const { mainApiWithToken } = await import('../../../apps/web/features/api/main.ts');
  const { RealmBrowseRoute } = await import('../../../apps/web/features/realm/routes.tsx');
  const { realmFrameReads } = await import('../../../apps/web/features/realm/read.ts');
  const { ZoneBrowse } = await import('../../../apps/web/features/zones/browse.tsx');
  const { mainRelationships } = await import('../../../apps/web/features/relationships/api.ts');
  const { isValidElement } = await import('react');
  type Node = import('react').ReactNode;
  type Model = import('../../../apps/web/features/zones/browse-view.ts').BrowseModel;
  const person = sessions[name];
  const retained = new Map<string, Promise<Response>>();
  let pageLabel = '';
  const frameLabel = (url: URL): string => {
    if (url.pathname.endsWith('/modules/browse')) return pageLabel;
    if (url.pathname.endsWith('/presentation')) return `frame-presentation${url.searchParams.has('after') ? `-${url.searchParams.get('after')}` : ''}`;
    if (url.pathname.endsWith('/routes')) return `frame-routes${url.searchParams.has('cursor') ? `-${url.searchParams.get('cursor')}` : ''}`;
    if (url.pathname === '/v1/addresses/resolve') return 'frame-address';
    if (/\/v1\/realms\/[^/]+$/.test(url.pathname)) return 'frame-realm-header';
    if (url.pathname.startsWith('/v1/follows/')) return 'frame-follow';
    return `frame-${url.pathname.split('/').at(-1)}`;
  };
  const transport = (personal: boolean): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    const label = frameLabel(url);
    const key = `${label}:${personal}:${request.method}:${url.pathname}${url.search}`;
    let pending = retained.get(key);
    if (!pending) {
      const headers = Object.fromEntries([...request.headers].filter(([header]) =>
        !['authorization', 'cookie', 'x-session-key'].includes(header)));
      const source = personal ? person : sessions.visitor;
      pending = recording.session(name, { main: async (...args) => {
        const response = await source.main(...args);
        if (response.status >= 400 && url.pathname.endsWith('/modules/browse'))
          console.error(`Anime production ${name}/${label} ${args[1]} HTTP ${response.status}: ${await response.clone().text()}`);
        return response;
      } })(label,
        request.method, url.pathname + url.search, undefined, undefined, { headers });
      retained.set(key, pending);
    }
    return (await pending).clone();
  }) as typeof fetch;
  const main = mainApiWithToken(undefined, { fetcher: transport(false) });
  const personal = person.actingSubject ? mainApiWithToken('persona-session', { fetcher: transport(true) }) : main;
  const client = { main, personal, signedIn: name !== 'visitor', actingSubject: person.actingSubject ?? undefined };
  const frame = realmFrameReads({ ...client, keepProblem: false });
  const resolved = await frame.resolveRealm(sessions.zone.slice(-36), 'en', 'site');
  expect(resolved.kind).toBe('realm');
  if (resolved.kind !== 'realm') throw new Error(`Anime site did not resolve: ${resolved.kind}`);
  // Resolve once for the canonical key; subsequent visits reuse the same actual frame answers.
  const siteKey = sessions.zone.slice(-36);
  await frame.readZoneRoute(sessions.zone.slice(-36), 'browse');
  function modelOf(node: Node): Model | null {
    if (Array.isArray(node)) return node.map(modelOf).find(Boolean) ?? null;
    if (!isValidElement<{ children?: Node; model?: Model }>(node)) return null;
    if (node.type === ZoneBrowse) return node.props.model ?? null;
    return modelOf(node.props.children);
  }
  const addresses: [string, Record<string, string>][] = [
    ['page-browse-default', {}], ['page-search-default', { q: phrase }],
    ['page-search-no-match', { q: `${phrase}nomatch` }],
    ['page-format', { concept: format.slice(-36) }], ['page-status', { status: 'completed' }],
    ['page-year', { year: '2004' }],
    ['page-combined', { concept: format.slice(-36), status: 'completed', year: '2004', q: phrase, sort: 'updated' }],
  ];
  for (const [label, address] of addresses) {
    let search = address;
    const ids: string[] = [], cursors = new Set<string>();
    for (let page = 0; ; page++) {
      pageLabel = page ? `${label}-continuation-${page}` : label;
      const rendered = await RealmBrowseRoute({
        params: Promise.resolve({ locale: 'en', realm: siteKey }), searchParams: Promise.resolve(search),
      }, undefined, client);
      const model = modelOf(rendered);
      expect(model, `${pageLabel} rendered the production catalogue`).not.toBeNull();
      if (!model) throw new Error(`${pageLabel} has no catalogue`);
      ids.push(...model.items.map(work => work.id));
      if (!model.next) break;
      const next = new URL(model.next, 'http://web.local');
      const cursor = next.searchParams.get('cursor');
      expect(cursor).toBeTruthy();
      expect(cursors.has(cursor!)).toBe(false);
      cursors.add(cursor!);
      for (const [key, value] of Object.entries(address)) {
        if (key !== 'sort' || value !== 'relevance') expect(next.searchParams.get(key)).toBe(value);
      }
      await frame.readZoneRoute(sessions.zone.slice(-36), 'browse', cursor!);
      search = Object.fromEntries(next.searchParams);
    }
    expect(new Set(ids).size).toBe(ids.length);
  }
  if (person.actingSubject) {
    const follow = await personal.v1.follows({ id: sessions.realm.slice(-36) }).get({
      query: { kind: 'realm', actingSubject: person.actingSubject },
    });
    const initial = follow.data as { following?: boolean | null; level?: string | null } | null;
    if (initial?.following == null || initial.level == null) {
      await mainRelationships(person.actingSubject, { origin: 'http://main.local', fetch: transport(true) })
        .state(resolved.header.id);
    }
  }
}
