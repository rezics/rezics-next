import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { recordZoneBrowseContinuation } from '../../../support/catalogue-story-reads.ts';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { BFF_PREFIX } from '../../../../../apps/web/features/api/browser.ts';
import { mainRelationships, RelationshipError } from '../../../../../apps/web/features/relationships/api.ts';
import { mainBrowseQuery, parseBrowseState } from '../../../../../apps/web/features/zones/browse-state.ts';
import catalogue from '../../../../../scripts/qa/cases/outcomes/recipes/catalogue-browse-and-search-in-its-zone.ts';
import { recipeCatalogue, short } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordFrameReads } from '../../../support/frame-reads.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(catalogue);
let inventory: Awaited<ReturnType<typeof recipeCatalogue>>;
const phrase = `Recipegarden${randomUUID().replaceAll('-', '')}`;
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

async function browse(name: PersonaName) {
  const person = sessions[name];
  await recordFrameReads(recording, name, person, sessions.visitor, sessions.realm, sessions.zone,
    'space', short(sessions.zone), 'browse');
  await recordFollowStateRefresh(name);
  await pageReads(name);
  const sample = recording.session(name, person);
  const path = `/v1/realms/${short(sessions.realm)}/modules/browse`;
  const refused = await answer<{ code: string }>(sample('unsupported-query-shape', 'GET', `${path}?sort=relevance&type=https%3A%2F%2Fschema.org%2FRecipe`), 400);
  expect(refused.code).toBe('unsupported_query_shape');
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of sort === 'relevance' ? [phrase] : ['', phrase]) {
      const query = new URLSearchParams({ sort, limit: '20', language: 'en', type: 'https://schema.org/Recipe', ...(q ? { q } : {}) });
      const seen: string[] = [];
      let page: Page;
      let pageNumber = 0;
      do {
        expect(seen.length).toBeLessThan(22);
        page = await answer<Page>(sample(`${q ? 'search' : 'browse'}-${sort}-${pageNumber++}`, 'GET', `${path}?${query}`));
        expect(page.items.some(item => inventory.excluded.includes(item.id))).toBe(false);
        seen.push(...page.items.map(item => item.id));
        if (page.nextCursor) query.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen).toHaveLength(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual([...inventory.matching].sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
      expect(page.window.complete).toBe(true);
    }
  }
  const none = await answer<Page>(sample('search-no-match', 'GET', `${path}?q=${phrase}Missing&type=https%3A%2F%2Fschema.org%2FRecipe&language=en`));
  expect(none.items).toEqual([]);
  expect(none.nextCursor).toBeNull();
  expect(none.matches).toEqual({ value: 0, kind: 'exact' });
  if (name === 'owner') await supportingReads(sample);
}
async function pageReads(name: PersonaName) {
  const publicRead = recording.session(name, sessions.visitor);
  const realmRoot = `/v1/realms/${short(sessions.realm)}`;
  if (name !== 'visitor') {
    const personalRead = recording.session(name, sessions[name]);
    const discard = async (pending: Promise<Response>, path: string) => {
      const response = await pending;
      if (response.status >= 500) throw new Error(`Page read ${path}: HTTP ${response.status}: ${await response.text()}`);
      await response.body?.cancel();
    };
    await discard(personalRead('frame-personal-realm-header', 'GET', realmRoot), realmRoot);
    const addressPath = `/v1/addresses/resolve?${new URLSearchParams({
      scope: 'space', key: short(sessions.space),
    })}`;
    await discard(personalRead('frame-personal-space-address', 'GET', addressPath), addressPath);
  }
  const addresses: [string, Record<string, string>][] = [
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
  for (const [label, address] of addresses) {
    let cursor: string | null = null;
    let continuation = 0;
    do {
      // Recipes adds no year filter, so catalogueBrowseQuery is exactly mainBrowseQuery here.
      const query = mainBrowseQuery(parseBrowseState({ ...address, ...(cursor ? { cursor } : {}) }));
      const params = new URLSearchParams(query as Record<string, string>);
      const path = `${realmRoot}/modules/browse${params.size ? `?${params}` : ''}`;
      const page = await answer<Page>(publicRead(continuation ? `${label}-continuation-${continuation}` : label, 'GET', path));
      if (label === 'page-browse-default' && continuation === 0) {
        await recordZoneBrowseContinuation(recording, name, sessions[name], sessions.zone, page.nextCursor);
      }
      cursor = page.nextCursor;
      continuation++;
    } while (cursor);
  }
}
/**
 * The header calls `state(realm)` when the follow it already read has no following or no level.
 * A visitor has no acting person. A joined follow with a level does not refresh.
 * The request carries the frame's acting person and the realm header's id, and no kind or body.
 */
async function recordFollowStateRefresh(name: PersonaName) {
  const person = sessions[name];
  const subject = person.actingSubject;
  if (!subject) {
    if (name !== 'visitor') throw new Error(`${name} has no acting person for the follow refresh`);
    return;
  }
  const header = await answer<{ id: string }>(sessions.visitor.main('GET', `/v1/realms/${short(sessions.realm)}`));
  expect(header.id).toBe(sessions.realm);
  const follow = await answer<{ following: boolean | null; level: string | null }>(person.main('GET',
    `/v1/follows/${short(sessions.realm)}?kind=realm&actingSubject=${encodeURIComponent(subject)}`));
  if (follow.following !== null && follow.level !== null) return;
  const sample = recording.session(name, person);
  let recordedPath = '';
  let failure: unknown;
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://record.invalid');
    const path = url.pathname.startsWith(BFF_PREFIX) ? url.pathname.slice(BFF_PREFIX.length) + url.search : url.pathname + url.search;
    recordedPath = path;
    if ((init?.method ?? 'GET') !== 'GET' || init?.body != null) throw new Error('Follow-state refresh is a GET with no body');
    try {
      return await sample('frame-follow-state', 'GET', path, undefined, undefined, {
        headers: Object.fromEntries(new Headers(init?.headers)),
      });
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  const api = mainRelationships(subject, {
    origin: 'http://record.invalid',
    fetch: Object.assign(send, { preconnect: globalThis.fetch.preconnect }),
  });
  try {
    await api.state(header.id);
  } catch (error) {
    if (failure) throw failure;
    if (!(error instanceof RelationshipError)) throw error;
  }
  const params = new URLSearchParams(recordedPath.slice(recordedPath.indexOf('?') + 1));
  expect(recordedPath.startsWith('/v1/me/follow-state?')).toBe(true);
  expect(params.get('actingSubject')).toBe(subject);
  expect(params.get('target')).toBe(header.id);
  expect(params.has('kind')).toBe(false);
  expect([...params.keys()]).toEqual(['actingSubject', 'target']);
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

outcomeTest(catalogue, 'visitor', () => browse('visitor'), recording);
outcomeTest(catalogue, 'stranger', () => browse('stranger'), recording);
outcomeTest(catalogue, 'member', () => browse('member'), recording);
outcomeTest(catalogue, 'owner', () => browse('owner'), recording);
outcomeTest(catalogue, 'moderator', () => browse('moderator'), recording);
outcomeTest(catalogue, 'operator', () => browse('operator'), recording);
