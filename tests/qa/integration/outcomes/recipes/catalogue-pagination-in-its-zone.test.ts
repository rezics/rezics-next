import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { mainApiWithToken } from '../../../../../apps/web/features/api/main.ts';
import { realmFrameReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import pagination from '../../../../../scripts/qa/cases/outcomes/recipes/catalogue-pagination-in-its-zone.ts';
import { recipeCatalogue, short } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { recordFrameReads } from '../../../support/frame-reads.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(pagination);
let inventory: Awaited<ReturnType<typeof recipeCatalogue>>;
const phrase = `Recipepages${randomUUID().replaceAll('-', '')}`;
type Page = { items: Array<{ id: string }>; nextCursor: string | null;
  matches: { value: number; kind: string }; window: { complete: boolean } };
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  await recording.prepare();

  const owner = sessions.owner, actor = owner.actingSubject;
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  const configurationHead = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}/configuration?actingSubject=${encodeURIComponent(actor!)}`));
  await answer(owner.main('PUT', `${zoneRoot}/configuration`, {
    expectedHead: configurationHead.revision, prepareHomeDocument: true, actingSubject: actor,
  }));
  const configuration = await answer<{ revision: string; configuration: { homeDocument: string } }>(
    owner.main('GET', `${zoneRoot}/configuration?actingSubject=${encodeURIComponent(actor!)}`));
  const navigation = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}?actingSubject=${encodeURIComponent(actor!)}`));
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: configuration.configuration.homeDocument, variantId, expectedHead: null,
      document: fromPlainText('Original Recipe fixture catalogue', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
    }), 201);
  await answer(owner.main('POST', `${zoneRoot}/site-publications`, {
    routesRevision: navigation.revision, navigationRevision: navigation.revision,
    expectedHead: configuration.revision, actingSubject: actor,
    pages: [{ page: configuration.configuration.homeDocument, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
  inventory = await recipeCatalogue(sessions, phrase);
  // A cursor pins count precision; wait for fixture writes before starting the proofs.
  const readyPath = `/v1/realms/${short(sessions.realm)}/modules/browse?${new URLSearchParams({
    q: `${phrase}Missing`, language: 'en', type: 'https://schema.org/Recipe', limit: '1',
  })}`;
  const deadline = AbortSignal.timeout(45_000);
  let stable = 0;
  let position: string | undefined;
  for (;;) {
    const ready = await answer<Page & { sourcePosition: { dataEpoch: string; sequence: string } }>(owner.main('GET', readyPath));
    const nextPosition = JSON.stringify(ready.sourcePosition);
    stable = ready.matches.kind === 'exact' ? (nextPosition === position ? stable + 1 : 1) : 0;
    position = nextPosition;
    if (stable === 5) break;
    deadline.throwIfAborted();
    await Bun.sleep(500);
  }
}, 300_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function traverse(name: PersonaName) {
  const person = sessions[name], path = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  const sample = recording.session(name, person);
  for (const sort of ['newest', 'updated', 'relevance']) {
    const query = new URLSearchParams({ q: phrase, sort, limit: '20', language: 'en', type: 'https://schema.org/Recipe' });
    const first = await answer<Page>(sample(`browse-${sort}-first`, 'GET', `${path}?${query}`));
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeString();
    expect(first.matches.kind).toBe('lower-bound');
    expect(first.matches.value).toBeGreaterThanOrEqual(20);
    expect(first.window.complete).toBe(false);
    query.set('cursor', first.nextCursor!);
    const second = await answer<Page>(sample(`browse-${sort}-continuation`, 'GET', `${path}?${query}`));
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.matches).toEqual({ value: 21, kind: 'exact' });
    expect(second.window.complete).toBe(true);
    const ids = [...first.items, ...second.items].map(item => item.id);
    expect(ids.sort()).toEqual([...inventory.matching].sort());
    expect(new Set(ids).size).toBe(21);
    expect(ids.some(id => inventory.excluded.includes(id))).toBe(false);
    const replay = await answer<Page>(sample(`browse-${sort}-replay`, 'GET', `${path}?${query}`));
    expect(replay.items.map(item => item.id)).toEqual(second.items.map(item => item.id));
    for (const [field, value] of [['q', `${phrase}Missing`], ['language', 'it'], ['type', 'https://schema.org/Book'], ['sort', sort === 'newest' ? 'updated' : 'newest']]) {
      const changed = new URLSearchParams(query);
      changed.set(field!, value!);
      await answer(sample(`cursor-${sort}-${field}-refused`, 'GET', `${path}?${changed}`), 400);
    }
  }
  await answer(sample('search-no-match', 'GET', `${path}?${new URLSearchParams({ q: `${phrase}Missing`, language: 'en', type: 'https://schema.org/Recipe' })}`));
  if (name === 'owner') await supportingReads(sample);
  await pageReads(name);
}

// These are the catalogue page's anonymous queries, without proof-only filters or limits.
async function pageReads(name: PersonaName) {
  const person = sessions[name];
  await recordFrameReads(recording, name, person, sessions.visitor, sessions.realm, sessions.zone,
    'space', short(sessions.space), 'browse');
  if (name !== 'visitor') {
    const personal = recording.session(name, person);
    await (await personal('frame-personal-realm-header', 'GET', `/v1/realms/${short(sessions.realm)}`)).body?.cancel();
    await (await personal('frame-personal-space-address', 'GET',
      `/v1/addresses/resolve?scope=space&key=${short(sessions.space)}`)).body?.cancel();
  }
  const publicRead = recording.session(name, sessions.visitor);
  const path = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  const shapes: Array<[string, Record<string, string>]> = [
    ['page-browse-default', {}],
    ['page-browse-newest', { sort: 'newest' }],
    ['page-browse-updated', { sort: 'updated' }],
    ['page-search-default', { q: phrase }],
    ['page-search-relevance', { q: phrase, sort: 'relevance' }],
    ['page-search-newest', { q: phrase, sort: 'newest' }],
    ['page-search-updated', { q: phrase, sort: 'updated' }],
    ['page-search-no-match', { q: `${phrase}Missing` }],
    ['page-search-no-match-relevance', { q: `${phrase}Missing`, sort: 'relevance' }],
  ];
  let searchNewestCursor: string | null = null;
  for (const [label, shape] of shapes) {
    const query = new URLSearchParams(shape);
    for (let page = 0; page < 5; page++) {
      const suffix = query.size ? `?${query}` : '';
      const result = await answer<Page>(publicRead(page ? `${label}-continuation-${page}` : label,
        'GET', `${path}${suffix}`));
      if (label === 'page-search-newest' && page === 0) searchNewestCursor = result.nextCursor;
      if (!result.nextCursor) break;
      query.set('cursor', result.nextCursor);
    }
  }
  if (!searchNewestCursor) throw new Error('Recipe search has no next page for the site route to follow');
  await recordProductionSiteContinuation(name, searchNewestCursor);
}

/** The site page resolves the published `/z/` key anonymously, then reads that zone's browse route for the cursor its own search returned. */
async function recordProductionSiteContinuation(name: PersonaName, cursor: string) {
  const person = sessions[name];
  const published = await answer<{ address?: { prefix?: string; key?: string } }>(
    sessions.visitor.main('GET', `/v1/zones/${short(sessions.zone)}/presentation`));
  const siteKey = published.address?.prefix === '/z/' ? published.address.key : undefined;
  if (!siteKey) throw new Error('Published Recipe zone has no site address');
  const counts = new Map<string, number>();
  const clientFor = (caller: PersonaSession) => {
    const sample = recording.session(name, caller);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      for (const forbidden of ['authorization', 'cookie', 'x-session-key']) headers.delete(forbidden);
      if (url.pathname.endsWith('/addresses/resolve')) {
        headers.set('accept-language', 'en');
        headers.set('x-rezics-display-languages', 'en');
      }
      const method = init?.method ?? 'GET';
      const path = `${url.pathname}${url.search}`;
      const base = url.pathname.endsWith('/addresses/resolve') ? 'site-address'
        : url.pathname.endsWith('/routes') ? 'site-search-newest-route'
        : url.pathname.endsWith('/presentation') ? 'site-presentation'
        : `site-${url.pathname.split('/').filter(Boolean).at(-1) ?? 'read'}`;
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      const text = typeof init?.body === 'string' ? init.body : undefined;
      return sample(seen === 0 ? base : `${base}-${seen + 1}`, method, path,
        text ? JSON.parse(text) as unknown : undefined, undefined, { headers: Object.fromEntries(headers) });
    }) as typeof fetch;
    return mainApiWithToken(caller.actingSubject ? 'recorded-session' : undefined, { fetcher });
  };
  const frames = realmFrameReads({
    main: clientFor(sessions.visitor),
    personal: clientFor(person),
    actingSubject: person.actingSubject ?? undefined,
  });
  const resolved = await frames.resolveSite(siteKey, 'en');
  if (resolved.kind !== 'site' || !resolved.realm)
    throw new Error(`Recipe site ${siteKey} resolved as ${resolved.kind}`);
  const routed = await frames.readZoneRoute(resolved.zone, 'browse', cursor);
  if (routed.ok) throw new Error('Recipe browse continuation route answered ok');
  if (routed.failure !== 'missing' || routed.status !== 404)
    throw new Error(`Recipe browse continuation route answered ${routed.status ?? 'no-status'} ${routed.failure}`);
}
// The browse route reads its frame, facet labels and the state of its cards separately.
async function supportingReads(sample: ReturnType<typeof recording.session>) {
  const acting = `actingSubject=${encodeURIComponent(sessions.owner.actingSubject!)}`;
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting}`;
  const realmRoot = `/v1/realms/${short(sessions.realm)}`;
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  await answer(sample('realm-context', 'GET', viewer(realmRoot)));
  await answer(sample('space-address', 'GET', viewer(`/v1/addresses/resolve?scope=space&key=${short(sessions.space)}`)));
  await answer(sample('zone-presentation', 'GET', viewer(`${zoneRoot}/presentation`)));
  await answer(sample('browse-route-fallback', 'GET', viewer(`${zoneRoot}/routes?path=browse`)), 404);
  await answer(sample('facet-labels', 'GET', '/v1/facets'));
  await answer(sample('type-labels', 'GET', '/v1/types'));
  const access = await answer<{ groups: string[]; operations: string[] }>(
    sample('platform-access', 'GET', '/v1/me/platform-access'));
  // The frame reads the viewer's ban only when Main opens that operation.
  if (access.groups.includes('realm-appeals') || access.operations.includes('getV1RealmsByRealmMember-ban')) {
    await answer(sample('member-ban-empty', 'GET', viewer(`${realmRoot}/member-ban`)), 404);
  }
  await answer(sample('joining-context', 'GET', viewer(`${realmRoot}/joining`)));
  await answer(sample('follow-context', 'GET', viewer(`/v1/follows/${short(sessions.realm)}?kind=realm`)));
  for (let offset = 0; offset < inventory.matching.length; offset += 20) {
    await answer(sample(`card-reader-states-${offset / 20}`, 'GET',
      viewer(`/v1/me/work-states?works=${encodeURIComponent(inventory.matching.slice(offset, offset + 20).join(','))}`)));
  }
  // Catalogue cards use each Work's classifications and statement section for their facts.
  const cardReads = async (work: string, index: number) => {
    const id = short(work);
    const projection = await answer<{ sections: { id: string; href: string }[] }>(
      sample(`card-${index}-projection`, 'GET', viewer(`/v1/resources/${id}/page`)));
    await answer(sample(`card-${index}-classifications`, 'GET', viewer(`/v1/works/${id}/classifications?scope=global`)));
    const section = projection.sections.find(item => item.id === 'statements');
    if (section) await answer(sample(`card-${index}-statements`, 'GET', viewer(section.href)));
  };
  for (let offset = 0; offset < inventory.matching.length; offset += 3) {
    const results = await Promise.allSettled(inventory.matching.slice(offset, offset + 3)
      .map((work, index) => cardReads(work, offset + index)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

outcomeTest(pagination, 'visitor', () => traverse('visitor'), recording);
outcomeTest(pagination, 'stranger', () => traverse('stranger'), recording);
outcomeTest(pagination, 'member', () => traverse('member'), recording);
outcomeTest(pagination, 'owner', () => traverse('owner'), recording);
outcomeTest(pagination, 'moderator', () => traverse('moderator'), recording);
outcomeTest(pagination, 'operator', () => traverse('operator'), recording);
