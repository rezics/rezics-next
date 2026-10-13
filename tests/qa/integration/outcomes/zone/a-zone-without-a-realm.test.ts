import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import independent from '../../../../../scripts/qa/cases/outcomes/zone/a-zone-without-a-realm.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
interface Saved {
  revisionId: string;
  byteDigest: string;
  sourcePosition: { dataEpoch: string };
}
interface Site {
  zone: string;
  page: string;
  zoneRevision: string;
  navigationRevision: string;
  variantId: string;
  document: DocumentSnapshot;
  saved: Saved;
}
interface Exact {
  reference: { revisionId: string; byteDigest: string; sourceRevision: string | null; provenance: Record<string, unknown> };
  body: { document: DocumentSnapshot };
}
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const fixtures = new Map<PersonaName, { sessions: PersonaSessions; site: Site }>();
beforeAll(async () => {
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    sessions = await personaSessions('public');
    fixtures.set(name, { sessions, site: await createSite() });
  }
}, 180_000);
afterAll(async () => { await sessions?.close(); });
function fixture(name: PersonaName) {
  const context = fixtures.get(name)!;
  sessions = context.sessions;
  return context.site;
}
const path = (site: Site) => `/v1/zones/${short(site.zone)}`;
const exactPath = (saved: Saved) => `/v1/content-revisions/${saved.revisionId}`;
function draftBody(site: Pick<Site, 'page' | 'variantId'>, person: PersonaSession, document: DocumentSnapshot, expectedHead: string | null) {
  return { profile: 'content-text-v1', resourceId: site.page, variantId: site.variantId,
    document, expectedHead, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
    direction: 'ltr', actingSubject: person.actingSubject ?? sessions.owner.actingSubject };
}
async function save(site: Site, document: DocumentSnapshot, expectedHead: string | null) {
  return answer<Saved>(sessions.owner.main('POST', '/v1/content-drafts',
    draftBody(site, sessions.owner, document, expectedHead)), 201);
}
async function configuration(site: Site, person = sessions.owner) {
  return answer<{ revision: string; configuration: { defaultRealm: string | null } }>(
    person.main('GET', `${path(site)}/configuration?${acting(person)}`));
}
async function createSite(): Promise<Site> {
  const created = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(
    sessions.owner.main('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Independent original site',
      language: 'en', capabilities: ['zone'], actingSubject: sessions.owner.actingSubject }), 201);
  const root = `/v1/zones/${short(created.zone)}`;
  await answer(sessions.owner.main('PUT', `${root}/configuration`, {
    expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject: sessions.owner.actingSubject }));
  const editor = await answer<{ configuration: { homeDocument: string }; draft: { variantId: string }; preview: { navigation: { revision: string } } }>(
    sessions.owner.main('GET', `${root}/showcase-editor?${acting(sessions.owner)}`));
  const site = { ...created, page: editor.configuration.homeDocument, variantId: editor.draft.variantId,
    navigationRevision: editor.preview.navigation.revision, document: fromPlainText('Original published garden', 'blocks') };
  const saved = await answer<Saved>(sessions.owner.main('POST', '/v1/content-drafts',
    draftBody(site, sessions.owner, site.document, null)), 201);
  return { ...site, saved };
}
async function publicationBody(site: Site, person: PersonaSession, saved = site.saved) {
  return { expectedHead: (await configuration(site)).revision, actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    routesRevision: site.navigationRevision, navigationRevision: site.navigationRevision,
    pages: [{ page: site.page, variantId: site.variantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch }] };
}
async function publish(site: Site, person = sessions.owner, saved = site.saved) {
  return answer<{ revision: string; themeRevision: string; pages: Array<{ revisionId: string }> }>(
    person.main('POST', `${path(site)}/site-publications`, await publicationBody(site, person, saved)), 201);
}
async function publicCut(site: Site, person: PersonaSession, saved = site.saved, document = site.document) {
  const home = await answer<{ realm: string | null; page: { reference: Exact['reference']; document: DocumentSnapshot } }>(
    person.main('GET', `${path(site)}/routes?path=%2F`));
  expect(home.realm).toBeNull();
  expect(home.page.document).toEqual(document);
  const exact = await answer<Exact>(person.main('GET', exactPath(saved)));
  expect(exact.body.document).toEqual(document);
  expect(exact.reference).toMatchObject({ resourceId: site.page, variantId: site.variantId,
    revisionId: saved.revisionId, byteDigest: saved.byteDigest, sourceRevision: null });
  expect(exact.reference.provenance).toMatchObject({ kind: 'admitted-original-contribution-v1',
    rightsBasis: 'original-contribution', author: sessions.owner.actingSubject,
    scope: `content:draft:${site.page}` });
  expect(home.page.reference.provenance).toEqual(exact.reference.provenance);
  return exact.reference.provenance;
}
async function denied(site: Site, person: PersonaSession, saved: Saved, status = 403) {
  const readStatus = person.actingSubject ? 404 : 401;
  await answer(person.main('GET', `${exactPath(saved)}?${acting(person)}`), readStatus);
  await answer(person.main('GET', `${path(site)}/showcase-editor?${acting(person)}`), readStatus);
  await answer(person.main('POST', '/v1/content-drafts',
    draftBody(site, person, fromPlainText('Unauthorized replacement', 'blocks'), saved.revisionId)), status);
  await answer(person.main('POST', `${path(site)}/site-publications`, await publicationBody(site, person, saved)), status);
}
async function reader(name: Exclude<PersonaName, 'owner' | 'operator'>) {
  const site = fixture(name), person = sessions[name];
  await publish(site);
  const provenance = await publicCut(site, person);
  const later = await save(site, fromPlainText('Private garden draft', 'blocks'), site.saved.revisionId);
  await answer(person.main('GET', exactPath(later)), 404);
  await denied(site, person, later, name === 'visitor' ? 401 : 403);
  expect(await publicCut(site, person)).toEqual(provenance);
}
async function platformPage() {
  return answer<{ authorityEpoch: string; items: Array<{ id: string; permission: string; scopeId: string; recipient: { principalId: string } }> }>(
    sessions.operator.main('GET', `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(sessions.operator.actingSubject!)}`));
}
async function exactMandate(site: Site) {
  const page = await platformPage();
  const principalId = page.items.find(item => item.permission === 'platform:grant')!.recipient.principalId;
  // The exact grant sorts after the broad grant, so authority cannot depend on UUID order.
  const lastId = page.items.map(item => item.id).sort().at(-1)!;
  const hex = (BigInt(`0x${lastId.replaceAll('-', '')}`) + 1n).toString(16).padStart(32, '0');
  const grantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const created = await answer<{ grant: { id: string; generation: string } }>(sessions.operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', issuerSubject: sessions.operator.actingSubject,
    expectedAuthorityEpoch: page.authorityEpoch, action: 'create', grantId,
    permission: 'platform:resource:zone.edit', scopeId: `zone:edit:${site.zone}`, recipient: { principalId }, validUntil: null }));
  expect(created.grant).toMatchObject({ id: grantId, active: true, permission: 'platform:resource:zone.edit',
    scopeId: `zone:edit:${site.zone}`, recipient: { principalId } });
  return created;
}

outcomeTest(independent, 'visitor', () => reader('visitor'));
outcomeTest(independent, 'stranger', () => reader('stranger'));
outcomeTest(independent, 'member', () => reader('member'));
outcomeTest(independent, 'owner', async () => {
  const site = fixture('owner'), owner = sessions.owner;
  expect((await configuration(site)).configuration.defaultRealm ?? null).toBeNull();
  expect(await answer(owner.main('GET', `${path(site)}/routes?path=%2F`))).not.toHaveProperty('page');
  await answer(sessions.visitor.main('GET', exactPath(site.saved)), 404);
  const preview = await answer<Exact>(owner.main('GET', `${exactPath(site.saved)}?${acting(owner)}`));
  expect(preview.body.document).toEqual(site.document);
  const first = await publish(site);
  const provenance = await publicCut(site, owner);
  const document = fromPlainText('Exact replacement garden', 'blocks');
  const later = await save(site, document, site.saved.revisionId);
  expect((await configuration(site)).revision).toBe(first.revision);
  await answer(sessions.visitor.main('GET', exactPath(later)), 404);
  expect((await answer<Exact>(owner.main('GET', `${exactPath(later)}?${acting(owner)}`))).body.document).toEqual(document);
  await answer(owner.main('POST', '/v1/content-drafts', draftBody(site, owner, site.document, site.saved.revisionId)), 409);
  await publicCut(site, sessions.visitor);
  const second = await publish(site, owner, later);
  expect(second.revision).not.toBe(first.revision);
  await publicCut(site, sessions.visitor, later, document);
  expect(preview.reference.provenance).toEqual(provenance);
  await answer(sessions.visitor.main('GET', exactPath(site.saved)), 404);
  const editor = await answer<{ draft: { revisionId: string; document: DocumentSnapshot } }>(
    owner.main('GET', `${path(site)}/showcase-editor?${acting(owner)}`));
  expect(editor.draft).toMatchObject({ revisionId: later.revisionId, document });
});
outcomeTest(independent, 'moderator', () => reader('moderator'));
outcomeTest(independent, 'operator', async () => {
  const site = fixture('operator'), operator = sessions.operator;
  await publish(site);
  const provenance = await publicCut(site, operator);
  const laterDocument = fromPlainText('Owner saved for later operator publication', 'blocks');
  const later = await save(site, laterDocument, site.saved.revisionId);
  expect((await platformPage()).items).toContainEqual(expect.objectContaining({
    permission: 'platform:resource:zone.edit', scopeId: 'zone:edit:*' }));
  await denied(site, operator, later);
  await exactMandate(site);
  expect((await answer<Exact>(operator.main('GET', `${exactPath(later)}?${acting(operator)}`))).body.document).toEqual(laterDocument);
  await publish(site, operator, later);
  const credit = await publicCut(site, sessions.visitor, later, laterDocument);
  expect(credit.author).toBe(provenance.author);
  const editor = await answer<{ draft: { revisionId: string; document: DocumentSnapshot } }>(
    operator.main('GET', `${path(site)}/showcase-editor?${acting(operator)}`));
  expect(editor.draft).toMatchObject({ revisionId: later.revisionId, document: laterDocument });
});
