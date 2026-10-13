import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import lifecycle from '../../../../../scripts/qa/cases/outcomes/zone/lifecycle.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
interface Saved { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }
type ZonePresentation = { tokens: { pageSurface: string; accent: string }; [field: string]: unknown };
interface Site { zone: string; page: string; root: string; variantId: string; navigationRevision: string; saved: Saved; document: DocumentSnapshot }
interface Exact { reference: { revisionId: string; byteDigest: string; sourceRevision: string | null; provenance: Record<string, unknown> }; body: { document: DocumentSnapshot } }
interface Presentation { revision: string; presentation: ZonePresentation; navigationRevision: string | null; navigation: unknown[]; home: { reference: Exact['reference']; document: DocumentSnapshot } }
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const fixtures = new Map<PersonaName, { sessions: PersonaSessions; site: Site }>();
beforeAll(async () => {
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    sessions = await personaSessions('public');
    fixtures.set(name, { sessions, site: await createSite() });
  }
}, 240_000);
afterAll(async () => { await sessions?.close(); });
function fixture(name: PersonaName) {
  const context = fixtures.get(name)!;
  sessions = context.sessions;
  return context.site;
}
async function configuration(site: Site) {
  return answer<{ revision: string; configuration: unknown }>(sessions.owner.main('GET', `${site.root}/configuration?${acting(sessions.owner)}`));
}
function draftBody(site: Pick<Site, 'page' | 'variantId'>, document: DocumentSnapshot, expectedHead: string | null) {
  return { profile: 'content-text-v1', resourceId: site.page, variantId: site.variantId, document, expectedHead,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: sessions.owner.actingSubject };
}
async function createSite(): Promise<Site> {
  const created = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(sessions.owner.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Retained original site', language: 'en', capabilities: ['zone'], actingSubject: sessions.owner.actingSubject }), 201);
  const root = `/v1/zones/${created.zone.slice(-36)}`;
  await answer(sessions.owner.main('PUT', `${root}/configuration`, { expectedHead: created.zoneRevision,
    prepareHomeDocument: true, actingSubject: sessions.owner.actingSubject }));
  const editor = await answer<{ revision: string; configuration: { homeDocument: string }; draft: { variantId: string };
    preview: { presentation: ZonePresentation; navigation: { revision: string } } }>(
    sessions.owner.main('GET', `${root}/showcase-editor?${acting(sessions.owner)}`));
  const presentation = structuredClone(editor.preview.presentation);
  presentation.tokens.pageSurface = 'cards';
  presentation.tokens.accent = '#224466';
  await answer(sessions.owner.main('PUT', `${root}/configuration`, { expectedHead: editor.revision,
    presentation, actingSubject: sessions.owner.actingSubject }));
  const document = fromPlainText('Retained original garden', 'blocks');
  const base = { zone: created.zone, page: editor.configuration.homeDocument, root, variantId: editor.draft.variantId,
    navigationRevision: editor.preview.navigation.revision, document };
  const saved = await answer<Saved>(sessions.owner.main('POST', '/v1/content-drafts', draftBody(base, document, null)), 201);
  const site = { ...base, saved };
  site.navigationRevision = await mount(site, 'published-guide', site.navigationRevision);
  return site;
}
async function mount(site: Site, segment: string, expectedHead: string) {
  const collection = `https://rezics.com/id/${randomUUID()}`;
  await answer(sessions.owner.main('POST', '/v1/collections', { collection, name: segment,
    disclosure: 'public', actingSubject: sessions.owner.actingSubject }), 201);
  const mounted = await answer<{ revision: string }>(sessions.owner.main('POST', `${site.root}/mounts`, {
    expectedHead, target: collection, routeSegment: segment, disclosure: 'public', actingSubject: sessions.owner.actingSubject }));
  return mounted.revision;
}
async function publicationBody(site: Site, person: PersonaSession) {
  return { expectedHead: (await configuration(site)).revision, actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    routesRevision: site.navigationRevision, navigationRevision: site.navigationRevision,
    pages: [{ page: site.page, variantId: site.variantId, revisionId: site.saved.revisionId,
      byteDigest: site.saved.byteDigest, contentEpoch: site.saved.sourcePosition.dataEpoch }] };
}
async function publish(site: Site, person = sessions.owner) {
  return answer<{ revision: string; themeRevision: string; navigationRevision: string; pages: Array<{ revisionId: string }> }>(
    person.main('POST', `${site.root}/site-publications`, await publicationBody(site, person)), 201);
}
async function publicBundle(site: Site, person: PersonaSession) {
  const home = await answer<{ page: { reference: Exact['reference']; document: DocumentSnapshot } }>(person.main('GET', `${site.root}/routes?path=%2F`));
  const exact = await answer<Exact>(person.main('GET', `/v1/content-revisions/${site.saved.revisionId}`));
  expect(home.page.document).toEqual(site.document);
  expect(exact.body.document).toEqual(site.document);
  expect(exact.reference).toMatchObject({ resourceId: site.page, variantId: site.variantId,
    revisionId: site.saved.revisionId, byteDigest: site.saved.byteDigest,
    sourceRevision: null, provenance: { kind: 'admitted-original-contribution-v1', rightsBasis: 'original-contribution',
      author: sessions.owner.actingSubject, scope: `content:draft:${site.page}` } });
  expect(home.page.reference.provenance).toEqual(exact.reference.provenance);
  const presentation = await answer<Presentation>(person.main('GET', `${site.root}/presentation`));
  expect(presentation.home.document).toEqual(site.document);
  expect(presentation.navigationRevision).toBe(site.navigationRevision);
  return { page: home.page, revision: presentation.revision, presentation: presentation.presentation,
    navigationRevision: presentation.navigationRevision, navigation: presentation.navigation };
}
async function transition(site: Site, operation: 'retirements' | 'recoveries', person = sessions.owner) {
  return answer(person.main('POST', `${site.root}/${operation}`, {
    expectedHead: (await configuration(site)).revision, actingSubject: person.actingSubject }));
}
async function assertHidden(site: Site, person: PersonaSession) {
  await answer(person.main('GET', `${site.root}/routes?path=%2F`), 404);
  await answer(person.main('GET', `${site.root}/presentation`), 404);
  await answer(person.main('GET', `/v1/content-revisions/${site.saved.revisionId}`), 404);
}
async function reader(name: Exclude<PersonaName, 'owner' | 'operator'>) {
  const site = fixture(name), person = sessions[name];
  await publish(site);
  const bundle = await publicBundle(site, person);
  const status = name === 'visitor' ? 401 : 403;
  await answer(person.main('GET', `${site.root}/configuration?${acting(person)}`), name === 'visitor' ? 401 : 404);
  await answer(person.main('PUT', `${site.root}/configuration`, { expectedHead: (await configuration(site)).revision,
    name: 'Unauthorized configuration', actingSubject: person.actingSubject ?? sessions.owner.actingSubject }), status);
  await answer(person.main('POST', `${site.root}/retirements`, { expectedHead: (await configuration(site)).revision,
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject }), status);
  await answer(person.main('POST', `${site.root}/site-publications`, await publicationBody(site, person)), status);
  await transition(site, 'retirements');
  await assertHidden(site, person);
  await answer(person.main('POST', `${site.root}/recoveries`, { expectedHead: (await configuration(site)).revision,
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject }), status);
  await transition(site, 'recoveries');
  expect(await publicBundle(site, person)).toEqual(bundle);
}
async function exactMandate(site: Site) {
  const operator = sessions.operator;
  const page = await answer<{ authorityEpoch: string; items: Array<{ id: string; permission: string; recipient: { principalId: string } }> }>(operator.main('GET',
    `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(operator.actingSubject!)}`));
  const principalId = page.items.find(item => item.permission === 'platform:grant')!.recipient.principalId;
  // The exact grant sorts after the broad grant, so authority cannot depend on UUID order.
  const lastId = page.items.map(item => item.id).sort().at(-1)!;
  const hex = (BigInt(`0x${lastId.replaceAll('-', '')}`) + 1n).toString(16).padStart(32, '0');
  const grantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const created = await answer<{ grant: unknown }>(operator.main('POST', '/v1/access/grant-changes', { profile: 'platform-grant-change-v1', issuerSubject: operator.actingSubject,
    expectedAuthorityEpoch: page.authorityEpoch, action: 'create', grantId, permission: 'platform:resource:zone.edit',
    scopeId: `zone:edit:${site.zone}`, recipient: { principalId }, validUntil: null }));
  expect(created.grant).toMatchObject({ id: grantId, active: true, permission: 'platform:resource:zone.edit',
    scopeId: `zone:edit:${site.zone}`, recipient: { principalId } });
}
async function steward(name: 'owner' | 'operator') {
  const site = fixture(name), person = sessions[name];
  if (name === 'operator') {
    await answer(person.main('POST', `${site.root}/retirements`, { expectedHead: (await configuration(site)).revision, actingSubject: person.actingSubject }), 403);
    await exactMandate(site);
  }
  const publication = await publish(site, person);
  expect(publication.navigationRevision).toBe(site.navigationRevision);
  expect(publication.pages[0]!.revisionId).toBe(site.saved.revisionId);
  const bundle = await publicBundle(site, sessions.visitor);
  expect(bundle.revision).toBe(publication.revision);
  expect(bundle.navigation).toHaveLength(1);
  expect(bundle.presentation.tokens.pageSurface).toBe('cards');
  const laterDocument = fromPlainText('Private retained later garden', 'blocks');
  const later = await answer<Saved>(sessions.owner.main('POST', '/v1/content-drafts', draftBody(site, laterDocument, site.saved.revisionId)), 201);
  const presentation = structuredClone(bundle.presentation);
  presentation.tokens.accent = '#663322';
  await answer(person.main('PUT', `${site.root}/configuration`, {
    expectedHead: (await configuration(site)).revision, presentation, actingSubject: person.actingSubject }));
  const laterNavigation = await mount(site, 'private-navigation-draft', site.navigationRevision);
  expect(laterNavigation).not.toBe(site.navigationRevision);
  expect(await publicBundle(site, sessions.visitor)).toEqual(bundle);
  const body = await publicationBody(site, person);
  await answer(person.main('POST', `${site.root}/site-publications`, { ...body, expectedHead: publication.revision }), 409);
  await answer(person.main('POST', `${site.root}/site-publications`, body), 409);
  expect(await publicBundle(site, sessions.visitor)).toEqual(bundle);
  await transition(site, 'retirements', person);
  await assertHidden(site, sessions.visitor);
  await answer(person.main('POST', `${site.root}/site-publications`, await publicationBody(site, person)), 400);
  await transition(site, 'recoveries', person);
  expect(await publicBundle(site, sessions.visitor)).toEqual(bundle);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${later.revisionId}`), 404);
  expect((await answer<Exact>(person.main('GET', `/v1/content-revisions/${later.revisionId}?${acting(person)}`))).body.document).toEqual(laterDocument);
  const editor = await answer<{ draft: { revisionId: string }; preview: { presentation: ZonePresentation; navigation: { revision: string; mounts: unknown[] } } }>(person.main('GET', `${site.root}/showcase-editor?${acting(person)}`));
  expect(editor.draft.revisionId).toBe(later.revisionId);
  expect(editor.preview.presentation.tokens.accent).toBe('#663322');
  expect(editor.preview.navigation.revision).toBe(laterNavigation);
  expect(editor.preview.navigation.mounts).toHaveLength(2);
}

outcomeTest(lifecycle, 'visitor', () => reader('visitor'));
outcomeTest(lifecycle, 'stranger', () => reader('stranger'));
outcomeTest(lifecycle, 'member', () => reader('member'));
outcomeTest(lifecycle, 'owner', () => steward('owner'));
outcomeTest(lifecycle, 'moderator', () => reader('moderator'));
outcomeTest(lifecycle, 'operator', () => steward('operator'));
