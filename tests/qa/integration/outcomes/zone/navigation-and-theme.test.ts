import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import row from '../../../../../scripts/qa/cases/outcomes/zone/navigation-and-theme.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type ZonePresentation = { tokens: Record<string, string>;
  slides: Array<{ id: string; href: string; title: string }>; [field: string]: unknown };
type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
type Reference = { resourceId: string; revisionId: string; provenance: { rightsBasis: string; author: string } };
type Home = { realm: string | null; page?: { reference: Reference; document: DocumentSnapshot } };
type Presentation = { revision: string; presentation: ZonePresentation; renderTokens: ZonePresentation['tokens'];
  navigation: Array<{ occurrence: string; segment: string }>; home?: Home['page'] };
type Receipt = { receipt: string; revision: string; homeDocument: string; homeRevision: string;
  routesRevision: string; navigationRevision: string; themeRevision: string;
  pages: Array<Pick<Page, 'page' | 'variantId' | 'revisionId'>>; replayed: boolean };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => { sessions = await personaSessions('public'); }, 180_000);
afterAll(async () => { await sessions?.close(); });

let fixture: Promise<Awaited<ReturnType<typeof prepareSite>>> | undefined;
const site = () => fixture ??= prepareSite();

async function prepareSite() {
  const owner = sessions.owner;
  const created = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(
    owner.main('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Published site',
      language: 'en', visibility: 'public', capabilities: ['zone'], actingSubject: owner.actingSubject }), 201);
  const path = `/v1/zones/${short(created.zone)}`;
  const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
    expectedHead: created.zoneRevision, prepareHomeDocument: true, defaultRealm: sessions.realm, actingSubject: owner.actingSubject,
  }));
  const configuration = await answer<{ configuration: { homeDocument: string } }>(
    owner.main('GET', `${path}/configuration${query(owner)}`));
  const homeDocument = configuration.configuration.homeDocument;
  expect(homeDocument).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(homeDocument).not.toBe(created.zone);
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draftBody = (document: DocumentSnapshot, expectedHead: string | null) => ({
    profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead, document,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    actingSubject: owner.actingSubject,
  });
  const save = async (document: DocumentSnapshot, expectedHead: string | null) => {
    const saved = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      owner.main('POST', '/v1/content-drafts', draftBody(document, expectedHead)), 201);
    return { page: homeDocument, variantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch } satisfies Page;
  };
  const publishedDocument = structuredClone(fromPlainText('Published owner text', 'blocks'));
  const unknownPayload = { future: [null, { preserved: true }], unicode: '雨夜書店' };
  publishedDocument.doc.content!.push(
    { type: 'extensionBlock', attrs: { id: 'showcase', dir: null, lang: null,
      definition: 'https://rezics.com/definition/showcase-block-v1', version: '1',
      payload: {}, fallback: 'Highlights' } },
    { type: 'extensionBlock', attrs: { id: 'unknown-map', dir: null, lang: null,
      definition: 'https://example.org/future-map', version: '9',
      payload: unknownPayload, fallback: 'Place map' } },
  );
  const collection = `https://rezics.com/id/${randomUUID()}`;
  await answer(owner.main('POST', '/v1/collections', { collection, name: 'Site references',
    disclosure: 'public', actingSubject: owner.actingSubject }), 201);
  const mounted = await answer<{ navigation: string; revision: string; occurrences: string[] }>(
    owner.main('POST', `${path}/mounts`, { expectedHead: created.navigationRevision,
      target: collection, routeSegment: 'published-link', disclosure: 'public', actingSubject: owner.actingSubject }));
  const baseline = await answer<{ presentation: ZonePresentation }>(
    sessions.visitor.main('GET', `${path}/presentation`));
  const publishedPresentation: ZonePresentation = { ...structuredClone(baseline.presentation),
    slides: [{ id: 'published-slide', href: '/published-link', title: 'Published highlight' }] };
  const themed = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
    expectedHead: prepared.revision, presentation: publishedPresentation, actingSubject: owner.actingSubject,
  }));
  const page = await save(publishedDocument, null);
  const publishBody = (selected: Page, expectedHead: string, navigationRevision = mounted.revision) => ({
    expectedHead, actingSubject: owner.actingSubject, routesRevision: navigationRevision,
    navigationRevision, pages: [selected],
  });
  const body = publishBody(page, themed.revision);
  const key = randomUUID();
  const receipt = await answer<Receipt>(owner.main('POST', `${path}/site-publications`, body, key), 201);
  const draftDocument = fromPlainText('Private subsequent owner text', 'blocks');
  const draft = await save(draftDocument, page.revisionId);
  const draftNavigation = await answer<{ revision: string; occurrences: string[] }>(owner.main('POST', `${path}/mounts`, {
    expectedHead: mounted.revision, target: collection, routeSegment: 'draft-link',
    disclosure: 'public', actingSubject: owner.actingSubject,
  }));
  const draftPresentation: ZonePresentation = { ...structuredClone(publishedPresentation),
    tokens: { ...publishedPresentation.tokens, density: 'compact', pageSurface: 'cards' },
    slides: [{ id: 'draft-slide', href: '/draft-link', title: 'Private draft highlight' }] };
  const configured = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
    expectedHead: receipt.revision, presentation: draftPresentation, actingSubject: owner.actingSubject,
  }));
  return { path, homeDocument, page, draft, publishedDocument, draftDocument, draftBody, publishBody, body, key, receipt,
    collection, mounted, draftNavigation, publishedPresentation, draftPresentation, configured, unknownPayload };
}

async function publicBundle(f: Awaited<ReturnType<typeof site>>, person: PersonaSession) {
  const delivered = await answer<Presentation>(person.main('GET', `${f.path}/presentation`));
  expect(delivered.presentation).toEqual(f.publishedPresentation);
  expect(delivered.renderTokens).toMatchObject(f.publishedPresentation.tokens);
  expect(delivered.navigation.map(item => item.segment)).toEqual(['published-link']);
  expect(delivered.home).toMatchObject({ document: f.publishedDocument, reference: {
    revisionId: f.page.revisionId, provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject },
  } });
  await answer(person.main('GET', `${f.path}/routes?path=%2Fpublished-link`));
  await answer(person.main('GET', `${f.path}/routes?path=%2Fdraft-link`), 404);
  return delivered;
}

async function privateNavigation(f: Awaited<ReturnType<typeof site>>, person: PersonaSession) {
  // Check both current and explicitly addressed history through the person's own session.
  const actor = person.actingSubject ?? sessions.owner.actingSubject!;
  for (const resource of [f.path, `${f.path}/revisions/${short(f.draftNavigation.revision)}`]) {
    const response = await person.main('GET', `${resource}?actingSubject=${encodeURIComponent(actor)}`);
    const raw = await response.text();
    if (response.status === 200) {
      expect(raw, `GET ${resource}: ${raw}`).not.toContain(f.draftNavigation.occurrences[0]!);
      expect(raw).not.toContain('draft-link');
    } else expect(response.status, raw).toBe(person.actingSubject ? 404 : 401);
  }
}

async function view(name: PersonaName) {
  const f = await site();
  const person = sessions[name];
  const before = await publicBundle(f, person);
  if (name !== 'visitor') {
    await answer(person.main('GET', `${f.path}/configuration${query(person)}`), 404);
    await answer(person.main('GET', `${f.path}/showcase-editor${query(person)}`), 404);
    await answer(person.main('PUT', `${f.path}/configuration`, { expectedHead: f.configured.revision,
      presentation: f.publishedPresentation, actingSubject: person.actingSubject }), 403);
    await answer(person.main('POST', `${f.path}/mounts`, { expectedHead: f.draftNavigation.revision,
      target: f.collection, routeSegment: 'unauthorized', disclosure: 'public', actingSubject: person.actingSubject }), 403);
    await answer(person.main('POST', `/v1/compositions/${short(f.mounted.navigation)}/changes`, {
      profile: 'zone-navigation', expectedHead: f.draftNavigation.revision, actingSubject: person.actingSubject,
      operations: [{ op: 'move', occurrence: f.mounted.occurrences[0], parent: f.mounted.navigation, position: 'last' }],
    }), 403);
  }
  expect(await publicBundle(f, sessions.visitor)).toEqual(before);
  await privateNavigation(f, person);
}

outcomeTest(row, 'visitor', () => view('visitor'));
outcomeTest(row, 'stranger', () => view('stranger'));
outcomeTest(row, 'member', () => view('member'));
outcomeTest(row, 'moderator', () => view('moderator'));
outcomeTest(row, 'operator', () => view('operator'));
outcomeTest(row, 'owner', async () => {
  const f = await site();
  const owner = sessions.owner;
  const before = await publicBundle(f, sessions.visitor);
  const configuration = await answer<{ revision: string; configuration: { presentation: ZonePresentation } }>(
    owner.main('GET', `${f.path}/configuration${query(owner)}`));
  expect(configuration.configuration.presentation).toEqual(f.draftPresentation);
  const navigation = await answer<{ revision: string; mounts: Array<{ occurrence: string }> }>(
    owner.main('GET', `${f.path}${query(owner)}`));
  expect(navigation.revision).toBe(f.draftNavigation.revision);
  expect(navigation.mounts.map(item => item.occurrence)).toContain(f.draftNavigation.occurrences[0]!);
  const stale = await answer<{ code: string }>(owner.main('PUT', `${f.path}/configuration`, {
    expectedHead: f.receipt.revision, presentation: f.publishedPresentation, actingSubject: owner.actingSubject,
  }), 409);
  expect(stale.code).toBe('stale_zone_head');
  for (const body of [f.publishBody(f.draft, f.receipt.revision, f.draftNavigation.revision),
    f.publishBody(f.draft, f.configured.revision, f.mounted.revision)]) {
    expect((await answer<{ code: string }>(owner.main('POST', `${f.path}/site-publications`, body), 409)).code)
      .toBe('stale_zone_head');
  }
  expect(await publicBundle(f, sessions.visitor)).toEqual(before);
  const next = await answer<Receipt>(owner.main('POST', `${f.path}/site-publications`,
    f.publishBody(f.draft, f.configured.revision, f.draftNavigation.revision)), 201);
  expect(next).toMatchObject({ routesRevision: f.draftNavigation.revision,
    navigationRevision: f.draftNavigation.revision, themeRevision: f.configured.revision });
  const delivered = await answer<Presentation>(sessions.visitor.main('GET', `${f.path}/presentation`));
  expect(delivered.presentation).toEqual(f.draftPresentation);
  expect(delivered.navigation.map(item => item.segment)).toEqual(['published-link', 'draft-link']);
  expect(delivered.home?.reference.revisionId).toBe(f.draft.revisionId);
  await answer(sessions.visitor.main('GET', `${f.path}/routes?path=%2Fdraft-link`));
});

