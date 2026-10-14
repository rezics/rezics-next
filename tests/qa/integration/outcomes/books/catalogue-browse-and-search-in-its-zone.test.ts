import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { readSpacePage } from '../../../../../apps/web/features/address/space-read.ts';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { gateFor, parsePlatformAccess } from '../../../../../apps/web/features/api/platform-access.ts';
import { realmFrameReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import { mainBrowseQuery, parseBrowseState } from '../../../../../apps/web/features/zones/browse-state.ts';
import catalogue from '../../../../../scripts/qa/cases/outcomes/books/catalogue-browse-and-search-in-its-zone.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Page<T> = { items: T[]; nextCursor: string | null; matches: { value: number; kind: string } };
// The proof keeps its 60 s. Recording the production page's reads has its own 120 s.
setDefaultTimeout(200_000);
const fileWall = setTimeout(() => {
  throw new Error('Books catalogue browse file exceeded 1500 s');
}, 1_500_000);
let sessions: PersonaSessions;
const works: Work[] = [];
const phrase = `Bookgarden${randomUUID().replaceAll('-', '')}`;
const recording = new OutcomeRecorder(catalogue);
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
      reason: 'Publish the original Book fixture catalogue',
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
  for (let index = 0; index < 21; index++) {
    const work = await answer<Work>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        title: `${phrase} ${index}`,
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        authoring: 'own-work',
        actingSubject: actor,
      }),
      201,
    );
    const draft = await answer<{ contribution: string; draftRevision: string }>(
      owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: `An original fixture story: gardener ${index} plants a seed and watches it grow.`,
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
  // A real public site supplies the browse frame's presentation and route answers.
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  const current = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`));
  await answer(owner.main('PUT', `${zoneRoot}/configuration`, {
    expectedHead: current.revision, prepareHomeDocument: true, actingSubject: actor,
  }));
  const configuration = await answer<{ revision: string; configuration: { homeDocument: string } }>(
    owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`));
  const navigation = await answer<{ revision: string }>(owner.main('GET', `${zoneRoot}?${acting(owner)}`));
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: configuration.configuration.homeDocument,
      variantId, expectedHead: null, document: fromPlainText('Original Book fixture catalogue', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor }), 201);
  await answer(owner.main('POST', `${zoneRoot}/site-publications`, {
    routesRevision: navigation.revision, navigationRevision: navigation.revision,
    expectedHead: configuration.revision, actingSubject: actor,
    pages: [{ page: configuration.configuration.homeDocument, variantId, revisionId: draft.revisionId,
      byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  }), 201);
  // The projection must catch up with fixture writes before a cursor pins its count precision.
  const readyPath = `${root}/modules/browse?${new URLSearchParams({ sort: 'newest', limit: '1',
    type: 'https://schema.org/Book', q: `${phrase}nomatch` })}`;
  const deadline = AbortSignal.timeout(45_000);
  let stable = 0;
  let position: string | undefined;
  for (;;) {
    const ready = await answer<Page<{ id: string }> & { sourcePosition: { dataEpoch: string; sequence: string } }>(
      owner.main('GET', readyPath));
    const nextPosition = JSON.stringify(ready.sourcePosition);
    stable = ready.matches.kind === 'exact' ? (nextPosition === position ? stable + 1 : 1) : 0;
    position = nextPosition;
    if (stable === 5) break;
    deadline.throwIfAborted();
    await Bun.sleep(500);
  }
}, 240_000);
afterAll(async () => {
  clearTimeout(fileWall);
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function browse(name: PersonaName) {
  const person = sessions[name];
  const sample = recording.session(name, person);
  const sampledCards = new Set<string>();
  const root = `/v1/realms/${short(sessions.realm)}/modules`;
  const refused = await answer<{ code: string }>(
    sample('unsupported-query-shape', 'GET', `${root}/browse?sort=relevance&limit=10&type=https%3A%2F%2Fschema.org%2FBook`),
    400,
  );
  expect(refused.code).toBe('unsupported_query_shape');
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'relevance' ? [phrase] : ['', phrase]) {
      const params = new URLSearchParams({
        sort,
        limit: '10',
        type: 'https://schema.org/Book',
        ...(q ? { q } : {}),
      });
      const seen: string[] = [];
      let pageNumber = 0;
      let page: Page<{ id: string }>;
      do {
        const path = `${root}/browse?${params}`;
        page = await answer<Page<{ id: string }>>(pageNumber === 0
          ? sample(`${q ? 'search' : 'browse'}-${sort}-${pageNumber}`, 'GET', path)
          : person.main('GET', path));
        if (pageNumber === 0) {
          for (const item of page.items) sampledCards.add(item.id);
          if (sort === 'newest' && !q) {
            expect(page.nextCursor).not.toBeNull();
            const continuationQuery = new URLSearchParams(params);
            continuationQuery.set('limit', '1');
            continuationQuery.set('cursor', page.nextCursor!);
            const continuation = await answer<Page<{ id: string }>>(sample('browse-newest-continuation', 'GET',
              `${root}/browse?${continuationQuery}`));
            expect(continuation.items).toHaveLength(1);
            expect(works.some(work => work.work === continuation.items[0]!.id)).toBe(true);
            expect(page.items.some(item => item.id === continuation.items[0]!.id)).toBe(false);
            expect(continuation.nextCursor).not.toBeNull();
            sampledCards.add(continuation.items[0]!.id);
          }
        }
        pageNumber++;
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen.length).toBe(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual(works.map((work) => work.work).sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
    }
  }
  const empty = await answer<Page<{ id: string }>>(sample('search-no-match', 'GET', `${root}/browse?${new URLSearchParams({
    sort: 'relevance', limit: '10', type: 'https://schema.org/Book', q: `${phrase}nomatch`,
  })}`));
  expect(empty.items).toEqual([]);
  expect(empty.nextCursor).toBeNull();
  expect(empty.matches).toEqual({ value: 0, kind: 'exact' });
  const first = await answer<Page<{ id: string }>>(
    sample('new-adoptions', 'GET', `${root}/new-adoptions?limit=20`),
  );
  expect(first.nextCursor).not.toBeNull();
  const second = await answer<Page<{ id: string }>>(
    sample('new-adoptions-continuation',
      'GET',
      `${root}/new-adoptions?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ),
  );
  expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
    works.map((work) => work.work).sort(),
  );
  expect(second.nextCursor).toBeNull();
  await supportingReads(name, sample, sampledCards);
}

async function within(milliseconds: number, part: string, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function qualify(name: PersonaName) {
  const started = Date.now();
  let proofMs = 0;
  let visitStarted = 0;
  try {
    await within(60_000, `${name} API proof`, () => browse(name));
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, `${name} production visit`, () => productionVisit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

const requestLabels = new AsyncLocalStorage<(method: string, path: string) => string>();
const issued = new Map<string, number>();
const named = <T,>(label: string, run: () => Promise<T>) => requestLabels.run((method, path) => {
  const stamp = `${label}\0${method}\0${path}`;
  if (issued.has(stamp)) throw new Error(`Production request repeated under ${label}: ${method} ${path}`);
  const count = issued.get(label) ?? 0;
  issued.set(label, count + 1);
  issued.set(stamp, count);
  return count === 0 ? label : `${label}-${count}`;
}, run);

let canonicalKey: string | undefined;

/**
 * The Books page opens the Zone site. The Realm space is only a community
 * address, so its canonical key carries no Zone capability. Probe the Zone
 * identity without recording it, then open that canonical key.
 */
async function siteKey(): Promise<string> {
  if (canonicalKey) return canonicalKey;
  const path = `/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(sessions.zone) })}`;
  const response = await sessions.visitor.main('GET', path, undefined, undefined, {
    headers: { 'accept-language': 'en', 'x-rezics-display-languages': 'en' },
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Zone address probe failed: HTTP ${response.status}: ${raw}`);
  const address = JSON.parse(raw) as {
    status?: string;
    canonical?: { key?: string };
    capabilities?: { zone?: string };
  };
  if (address.status !== 'resolved' || !address.canonical?.key) throw new Error(`Zone address has no canonical key: ${raw}`);
  if (!address.capabilities?.zone) throw new Error(`Zone address has no zone capability: ${raw}`);
  canonicalKey = address.canonical.key;
  return canonicalKey;
}

/**
 * One production browse page. The Books package does not offer a catalogue year,
 * and this publication leaves the official package unset, so the route sends
 * `mainBrowseQuery`: no limit, type, language or actingSubject.
 */
async function productionVisit(name: PersonaName) {
  issued.clear();
  const person = sessions[name];
  const actingSubject = person.actingSubject ?? undefined;
  const key = await siteKey();
  const clientFor = (caller: PersonaSession) => browserMainApi('https://record.invalid', {
    fetcher: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
      const method = init?.method ?? 'GET';
      const label = requestLabels.getStore()?.(method, path);
      if (!label) throw new Error(`Production request has no label: ${method} ${path}`);
      try {
        return await recording.session(name, caller)(label, method, path,
          typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
          new Headers(init?.headers).get('idempotency-key') ?? undefined,
          { headers: { 'accept-language': 'en', 'x-rezics-display-languages': 'en' } });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Production request ${method} ${path} failed: ${detail}`);
      }
    }) as typeof fetch,
  });
  const personal = clientFor(person);
  const anonymous = clientFor(sessions.visitor);
  const frames = realmFrameReads({ main: anonymous, personal, actingSubject });
  const addresses = new Map<string, ReturnType<typeof frames.readAddress>>();
  const presentations = new Map<string, ReturnType<typeof frames.readCompletePresentation>>();
  let header: ReturnType<typeof frames.readRealmHeader> | undefined;
  let sessionAgent: ReturnType<typeof personal.v1.me['session-agent']['get']> | undefined;
  const readSessionAgent = () => {
    sessionAgent ??= named('frame-session-agent', () => personal.v1.me['session-agent'].get());
    return sessionAgent;
  };
  const recordedResponse = async (caller: PersonaSession, method: string, path: string) => {
    const label = requestLabels.getStore()?.(method, path);
    if (!label) throw new Error(`Production request has no label: ${method} ${path}`);
    try {
      return await recording.session(name, caller)(label, method, path, undefined, undefined, {
        headers: { 'accept-language': 'en', 'x-rezics-display-languages': 'en' },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Production request ${method} ${path} failed: ${detail}`);
    }
  };
  const reader = realmFrameReads({
    main: anonymous, personal, actingSubject,
    resolution: {
      resolveAddress: (_scope, addressKey, locale) => {
        let read = addresses.get(addressKey);
        if (!read) {
          read = named('frame-address', () => frames.readAddress(addressKey, locale));
          addresses.set(addressKey, read);
        }
        return read;
      },
      // A resolved address without a Zone capability enters this reader. It does not invent a Zone.
      readPrivateRealm: async (ref, _locale, address) => {
        if (actingSubject) await readSessionAgent();
        return readSpacePage(ref, 'en', {
          address,
          ...(actingSubject ? { token: 'persona-session', actingSubject } : {}),
          read: (path, personalRead = false) => named(
            path.includes('/join-page') ? 'frame-private-join-page' : 'frame-private-header',
            () => recordedResponse(personalRead ? person : sessions.visitor, 'GET', path),
          ),
        });
      },
      readCompletePresentation: zone => {
        let read = presentations.get(zone);
        if (!read) {
          read = (async () => {
            // The server token client reads the session and preferences before the first personal read.
            if (actingSubject) {
              await readSessionAgent();
              await named('frame-person-preferences', () => personal.v1.me['person-preferences'].get({ query: { actingSubject } }));
            }
            return named('frame-presentation', () => frames.readCompletePresentation(zone));
          })();
          presentations.set(zone, read);
        }
        return read;
      },
      readRealmHeader: realm => {
        header ??= named('frame-realm-header', () => frames.readRealmHeader(realm));
        return header;
      },
    },
  });
  const resolved = await reader.resolveSite(key, 'en');
  if (resolved.kind !== 'site' || !resolved.realm) {
    throw new Error(`Production site did not resolve a Books Zone for ${name} at ${key}: ${resolved.kind}`);
  }
  const zone = resolved.zone;
  const realm = resolved.realm;
  await named('frame-routes', () => reader.readZoneRoute(zone, 'browse'));
  const view = await reader.resolveRealm(key, 'en', 'site');
  if (view.kind !== 'realm') throw new Error(`Production realm did not resolve for ${name}: ${view.kind}`);
  const realmId = view.header.id.slice(-36);
  await Promise.all([
    presentations.get(zone),
    actingSubject ? named('frame-joining', () => personal.v1.realms({ realm: realmId }).joining.get({ query: { actingSubject } })) : null,
    actingSubject ? named('frame-follow', () => personal.v1.follows({ id: realmId }).get({ query: { kind: 'realm', actingSubject } })) : null,
    actingSubject ? (async () => {
      const access = await named('frame-platform-access', () => personal.v1.me['platform-access'].get());
      // The page asks for the member's ban only while that operation is open for this viewer.
      if (gateFor(parsePlatformAccess(access.data))('getV1RealmsByRealmMember-ban')) {
        await named('frame-member-ban', () => personal.v1.realms({ realm: realmId })['member-ban'].get({ query: { actingSubject } }));
      }
    })() : null,
    named('frame-facets', () => frames.readFacets()),
  ]);
  const pages: [string, Record<string, string>][] = [
    ['page-browse-default', {}],
    ['page-browse-newest', { sort: 'newest' }],
    ['page-browse-updated', { sort: 'updated' }],
    ['page-search-default', { q: phrase }],
    ['page-search-relevance', { q: phrase, sort: 'relevance' }],
    ['page-search-newest', { q: phrase, sort: 'newest' }],
    ['page-search-updated', { q: phrase, sort: 'updated' }],
    ['page-search-no-match', { q: `${phrase}nomatch` }],
    ['page-search-no-match-relevance', { q: `${phrase}nomatch`, sort: 'relevance' }],
  ];
  for (const [label, address] of pages) {
    let cursor: string | null = null;
    let continuation = 0;
    do {
      if (cursor) await named(`${label}-zone-continuation${continuation > 1 ? `-${continuation}` : ''}`,
        () => reader.readZoneRoute(zone, 'browse', cursor!));
      const query = mainBrowseQuery(parseBrowseState({ ...address, ...(cursor ? { cursor } : {}) }));
      const pageLabel = continuation ? `${label}-continuation-${continuation}` : label;
      const answer = await named(pageLabel, () => anonymous.v1.realms({ realm }).modules.browse.get({
        query: { ...query, actingSubject: query.actingSubject },
      }));
      if (answer.error || !answer.data) {
        throw new Error(`Production browse ${pageLabel} for ${name} answered HTTP ${answer.error?.status ?? 0}: ${JSON.stringify(answer.error?.value ?? null)}`);
      }
      cursor = (answer.data as Page<{ id: string }>).nextCursor;
      continuation++;
      if (cursor && continuation > 8) throw new Error(`Production browse ${label} for ${name} kept a cursor past 8 pages`);
    } while (cursor);
  }
}

async function supportingReads(name: PersonaName, sample: ReturnType<typeof recording.session>, sampledCards: Set<string>) {
  const person = sessions[name];
  const viewer = (path: string) => person.actingSubject ? `${path}${path.includes('?') ? '&' : '?'}${acting(person)}` : path;
  const realmRoot = `/v1/realms/${short(sessions.realm)}`;
  const zoneRoot = `/v1/zones/${short(sessions.zone)}`;
  const realm = await answer<{ id: string }>(sample('realm-context', 'GET', viewer(realmRoot)));
  expect(realm.id).toBe(sessions.realm);
  const address = await answer<{ capabilities: { realm: string } }>(sample('space-address', 'GET',
    viewer(`/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(sessions.space) })}`)));
  expect(address.capabilities.realm).toBe(sessions.realm);
  const presentation = await answer<{ zone: string; realm: string }>(sample('zone-presentation', 'GET', viewer(`${zoneRoot}/presentation`)));
  expect(presentation.zone).toBe(sessions.zone);
  expect(presentation.realm).toBe(sessions.realm);
  const route = await answer<{ code: string }>(sample('browse-route-fallback', 'GET', viewer(`${zoneRoot}/routes?path=browse`)), 404);
  expect(route.code).toBe('route_missing');
  const facets = await answer<{ facets: unknown[] }>(sample('facet-labels', 'GET', '/v1/facets'));
  expect(Array.isArray(facets.facets)).toBe(true);
  // An absent count definition is the page's truthful no-count answer.
  const definition = await sample('volume-count-definition', 'GET', viewer('/v1/lexicon/definitions/volume-count?languages=en'));
  expect([200, 404]).toContain(definition.status);
  await definition.body?.cancel();
  if (person.actingSubject) {
    await answer(sample('joining-context', 'GET', `${realmRoot}/joining?${acting(person)}`));
    await answer(sample('follow-context', 'GET', `/v1/follows/${short(sessions.realm)}?kind=realm&${acting(person)}`));
  }
  const cardReads = async (work: Work, index: number) => {
    const id = short(work.work);
    const [projection, classifications] = await Promise.all([
      answer<{ sections: { id: string; href: string }[] }>(
        sample(`card-${index}-projection`, 'GET', viewer(`/v1/resources/${id}/page`))),
      answer<{ items: unknown[]; nextCursor: string | null }>(
        sample(`card-${index}-classifications`, 'GET', viewer(`/v1/works/${id}/classifications?scope=global`))),
    ]);
    expect(classifications.nextCursor).toBeNull();
    expect(Array.isArray(classifications.items)).toBe(true);
    const section = projection.sections.find(item => item.id === 'statements');
    expect(section).toBeDefined();
    const statements = await answer<{ groups: unknown[]; nextCursor: string | null }>(
      sample(`card-${index}-statements`, 'GET', viewer(section!.href)));
    expect(statements.nextCursor).toBeNull();
    expect(Array.isArray(statements.groups)).toBe(true);
  };
  // The populated browse samples and bounded continuation carry only cards whose facts are proved here.
  const cards = works.flatMap((work, index) => sampledCards.has(work.work) ? [{ work, index }] : []);
  for (let offset = 0; offset < cards.length; offset += 3) {
    const results = await Promise.allSettled(cards.slice(offset, offset + 3).map(({ work, index }) => cardReads(work, index)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

outcomeTest(catalogue, 'visitor', () => qualify('visitor'), recording);
outcomeTest(catalogue, 'stranger', () => qualify('stranger'), recording);
outcomeTest(catalogue, 'member', () => qualify('member'), recording);
outcomeTest(catalogue, 'owner', () => qualify('owner'), recording);
outcomeTest(catalogue, 'moderator', () => qualify('moderator'), recording);
outcomeTest(catalogue, 'operator', () => qualify('operator'), recording);
