import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import row from '../../../../../scripts/qa/cases/outcomes/zone/publication.ts';
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

async function withExactZoneAuthority(zone: string, use: () => Promise<void>) {
  const operator = sessions.operator;
  const issuerSubject = operator.actingSubject!;
  const listing = await answer<{ authorityEpoch: string;
    items: Array<{ permission: string; issuerSubject: string; active: boolean;
      recipient: { principalId?: string } }> }>(
    operator.main('GET', `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(issuerSubject)}`));
  const principalId = listing.items.find(grant => grant.permission === 'platform:grant'
    && grant.issuerSubject === issuerSubject && grant.active)?.recipient.principalId;
  expect(principalId).toBeDefined();
  // This exact grant sorts after the bootstrap wildcard grants; it must still authorize this resource.
  const grantId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const mandate = await answer<{ authorityEpoch: string; grant: { generation: string } }>(
    operator.main('POST', '/v1/access/grant-changes', { profile: 'platform-grant-change-v1',
      action: 'create', issuerSubject, expectedAuthorityEpoch: listing.authorityEpoch, grantId,
      permission: 'platform:resource:zone.edit', scopeId: `zone:edit:${zone}`,
      recipient: { principalId }, validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }));
  try { await use(); }
  finally {
    await answer(operator.main('POST', '/v1/access/grant-changes', { profile: 'platform-grant-change-v1',
      action: 'revoke', issuerSubject, expectedAuthorityEpoch: mandate.authorityEpoch, grantId,
      expectedObjectGeneration: mandate.grant.generation,
    }));
  }
}

async function refuses(name: Exclude<PersonaName, 'owner'>) {
  const f = await site();
  const person = sessions[name];
  const before = await publicBundle(f, person);
  const ownBody = { ...f.publishBody(f.draft, f.configured.revision, f.draftNavigation.revision),
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject };
  await answer(person.main('POST', `${f.path}/site-publications`, ownBody), name === 'visitor' ? 401 : 403);
  // A foreign principal may neither impersonate the owner nor obtain its existing receipt.
  await answer(person.main('POST', `${f.path}/site-publications`, f.body, f.key), name === 'visitor' ? 401 : 403);
  expect(await publicBundle(f, sessions.visitor)).toEqual(before);
  if (name === 'operator') {
    // The resource mandate is assigned to the operator's own principal, never to the owner's Agent.
    const owner = sessions.owner;
    const path = `/v1/zones/${short(sessions.zone)}`;
    const config = await answer<{ revision: string }>(owner.main('GET', `${path}/configuration${query(owner)}`));
    const prepared = await answer<{ revision: string }>(owner.main('PUT', `${path}/configuration`, {
      expectedHead: config.revision, prepareHomeDocument: true, actingSubject: owner.actingSubject,
    }));
    const home = await answer<{ configuration: { homeDocument: string } }>(
      owner.main('GET', `${path}/configuration${query(owner)}`));
    const resourceId = home.configuration.homeDocument;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      owner.main('POST', '/v1/content-drafts', { ...f.draftBody(fromPlainText('Owner credited administrator publication', 'blocks'), null),
        resourceId, variantId }), 201);
    const navigation = await answer<{ revision: string }>(owner.main('GET', `${path}${query(owner)}`));
    const body = { expectedHead: prepared.revision, actingSubject: person.actingSubject,
      routesRevision: navigation.revision, navigationRevision: navigation.revision,
      pages: [{ page: resourceId, variantId, revisionId: saved.revisionId,
        byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch }] };
    await answer(person.main('POST', `${path}/site-publications`, body), 403);
    await withExactZoneAuthority(sessions.zone, async () => {
      const key = randomUUID();
      const committed = await answer<Receipt>(person.main('POST', `${path}/site-publications`, body, key), 201);
      const replay = await answer<Receipt>(person.main('POST', `${path}/site-publications`, body, key));
      expect(replay).toEqual({ ...committed, replayed: true });
      const published = await answer<Home>(sessions.visitor.main('GET', `${path}/routes?path=%2F`));
      expect(published.page?.reference).toMatchObject({ revisionId: saved.revisionId,
        provenance: { rightsBasis: 'original-contribution', author: owner.actingSubject } });
      const exact = await answer<{ reference: Reference }>(sessions.visitor.main('GET',
        `/v1/content-revisions/${saved.revisionId}`));
      expect(exact.reference).toEqual(published.page!.reference);
    });
  }
}

outcomeTest(row, 'visitor', () => refuses('visitor'));
outcomeTest(row, 'stranger', () => refuses('stranger'));
outcomeTest(row, 'member', () => refuses('member'));
outcomeTest(row, 'moderator', () => refuses('moderator'));
outcomeTest(row, 'operator', () => refuses('operator'));
outcomeTest(row, 'owner', async () => {
  const f = await site();
  const owner = sessions.owner;
  const body = f.publishBody(f.draft, f.configured.revision, f.draftNavigation.revision);
  // The browser's legacy Zone page identity is refused by this contract; a prepared home is required.
  const legacy = await answer<{ code: string }>(owner.main('POST', `${f.path}/site-publications`, {
    ...body, pages: [{ ...f.draft, page: f.path.replace('/v1/zones/', 'https://rezics.com/id/') }],
  }), 400);
  expect(legacy.code).toBe('invalid_zone_configuration');
  const key = randomUUID();
  const discarded = await owner.main('POST', `${f.path}/site-publications`, body, key);
  expect(discarded.status).toBe(201);
  await discarded.body?.cancel();
  // No receipt body from the successful HTTP response reaches this client.
  const replay = await answer<Receipt>(owner.main('POST', `${f.path}/site-publications`, body, key));
  expect(replay.replayed).toBe(true);
  expect(replay).toMatchObject({ homeDocument: f.homeDocument, navigationRevision: f.draftNavigation.revision,
    routesRevision: f.draftNavigation.revision, themeRevision: f.configured.revision,
    pages: [{ page: f.homeDocument, variantId: f.draft.variantId, revisionId: f.draft.revisionId }] });
  const selected = await answer<Presentation>(sessions.visitor.main('GET', `${f.path}/presentation`));
  expect(selected.presentation).toEqual(f.draftPresentation);
  expect(selected.home?.reference).toMatchObject({ revisionId: f.draft.revisionId,
    provenance: { rightsBasis: 'original-contribution', author: owner.actingSubject } });
  expect(selected.navigation.map(item => item.segment)).toEqual(['published-link', 'draft-link']);
  await answer(sessions.visitor.main('GET', `${f.path}/routes?path=%2Fdraft-link`));
  const laterDocument = fromPlainText('Competing committed home', 'blocks');
  const saved = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    owner.main('POST', '/v1/content-drafts', f.draftBody(laterDocument, f.draft.revisionId)), 201);
  const laterPage: Page = { ...f.draft, revisionId: saved.revisionId,
    byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch };
  const laterPresentation: ZonePresentation = { ...structuredClone(f.draftPresentation),
    tokens: { ...f.draftPresentation.tokens, density: 'comfortable' } };
  const configuration = await answer<{ revision: string }>(owner.main('PUT', `${f.path}/configuration`, {
    expectedHead: replay.revision, presentation: laterPresentation, actingSubject: owner.actingSubject,
  }));
  const navigation = await answer<{ revision: string }>(owner.main('POST', `${f.path}/mounts`, {
    expectedHead: f.draftNavigation.revision, target: f.collection, routeSegment: 'competing-link',
    disclosure: 'public', actingSubject: owner.actingSubject,
  }));
  const competing = await answer<Receipt>(owner.main('POST', `${f.path}/site-publications`,
    f.publishBody(laterPage, configuration.revision, navigation.revision)), 201);
  const current = await answer<Presentation>(sessions.visitor.main('GET', `${f.path}/presentation`));
  expect(current.revision).toBe(competing.revision);
  expect(current.home?.document).toEqual(laterDocument);
  expect(current.presentation).toEqual(laterPresentation);
  expect(current.navigation.map(item => item.segment)).toEqual(['published-link', 'draft-link', 'competing-link']);
  const original = await answer<Receipt>(owner.main('POST', `${f.path}/site-publications`, body, key));
  expect(original).toEqual(replay);
  expect((await answer<{ code: string }>(owner.main('POST', `${f.path}/site-publications`,
    { ...body, expectedHead: competing.revision }, key), 409)).code).toBe('idempotency_conflict');
  expect((await answer<{ code: string }>(owner.main('POST', `${f.path}/site-publications`, body), 409)).code)
    .toBe('stale_zone_head');
  expect(await answer<Presentation>(sessions.visitor.main('GET', `${f.path}/presentation`))).toEqual(current);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${f.draft.revisionId}`), 404);
  const exact = await answer<{ reference: Reference }>(sessions.visitor.main('GET', `/v1/content-revisions/${laterPage.revisionId}`));
  expect(exact.reference.provenance).toMatchObject({ rightsBasis: 'original-contribution', author: owner.actingSubject });
});

