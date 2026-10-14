import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { realmFrameReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import { readManagementAddress, suppliedManagementSite, zoneAuthoringFromAddress, zoneLifecycleFromAddress, zoneManagementFrameFromReads } from '../../../../../apps/web/features/zone-editor/authoring-reads.ts';
import { loadSavedPreviewFrame } from '../../../../../apps/web/features/zone-editor/saved-preview-frame.ts';
import { readShowcaseEditor, showcaseEditorAuthority } from '../../../../../apps/web/features/zone-editor/edit-site-link.tsx';
import { independentZoneHomeBoundary, readIndependentZoneHome } from '../../../../../apps/web/features/zones/independent-zone-recorded-page.ts';
import { installedDigest, loadPackage } from '../../../../../apps/web/zones/official/index.ts';
import { declaredData } from '../../../../../apps/web/zones/official/declared.ts';
import { browserZoneAuthoring, commitCommand, loadCompleteZoneNavigation, zoneCommandLane } from '../../../../../apps/web/features/zone-editor/api.ts';
import { draftChoice, draftWire, publicationChoice, reduceEditor } from '../../../../../apps/web/features/zone-editor/model.ts';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import revoked from '../../../../../scripts/qa/cases/outcomes/zone/publish-after-editor-revocation-revoked-editors.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(210_000);
const recording = new OutcomeRecorder(revoked);
let sessions: PersonaSessions;
interface Saved { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }
interface Site { space: string; zone: string; page: string; root: string; variantId: string; navigationRevision: string; saved: Saved; later: Saved;
  document: DocumentSnapshot; laterDocument: DocumentSnapshot; publicationKey: string; committedKey: string }
interface Exact { reference: { revisionId: string; byteDigest: string; sourceRevision: string | null; provenance: Record<string, unknown> }; body: { document: DocumentSnapshot } }
interface Access { authorityEpoch: string; you: Array<{ representationId: string; generation: string }> }
interface Grant { id: string; generation: string }
const acting = (subject: string) => `actingSubject=${encodeURIComponent(subject)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function access(person: PersonaSession, subject: string) {
  return answer<Access>(person.main('GET', `/v1/agents/${subject.slice(-36)}/access`));
}
async function invite(issuer: PersonaSession, subject: string, recipient: PersonaSession) {
  const invitationId = randomUUID();
  await answer(issuer.main('POST', '/v1/agents/invitations', {
    profile: 'access-agent-invitation-v1', invitationId, issuerSubject: subject,
    recipientSubject: recipient.actingSubject, offer: 'control', issuerLifetime: 'institutional',
    expectedAuthorityEpoch: (await access(issuer, subject)).authorityEpoch }));
  const representationId = randomUUID();
  await answer(recipient.main('POST', '/v1/agents/invitation-acceptances', {
    profile: 'access-agent-invitation-acceptance-v1', invitationId, representationId,
    expectedAuthorityEpoch: (await access(issuer, subject)).authorityEpoch }));
  return representationId;
}
async function removeController(issuer: PersonaSession, subject: string, representationId: string, generation: string) {
  await answer(issuer.main('POST', '/v1/agents/controller-changes', {
    profile: 'access-agent-controller-change-v1', action: 'remove', subjectId: subject,
    representationId, expectedGeneration: generation, expectedAuthorityEpoch: (await access(issuer, subject)).authorityEpoch }));
}
async function configuration(site: Site) {
  return answer<{ revision: string }>(sessions.owner.main('GET', `${site.root}/configuration?${acting(sessions.owner.actingSubject!)}`));
}
function draftBody(site: Pick<Site, 'page' | 'variantId'>, subject: string, document: DocumentSnapshot, expectedHead: string | null) {
  return { profile: 'content-text-v1', resourceId: site.page, variantId: site.variantId, document, expectedHead,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: subject };
}
async function publicationBody(site: Site, subject: string, saved = site.later) {
  return { expectedHead: (await configuration(site)).revision, actingSubject: subject,
    routesRevision: site.navigationRevision, navigationRevision: site.navigationRevision,
    pages: [{ page: site.page, variantId: site.variantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch }] };
}
async function publicBundle(site: Site, person: PersonaSession) {
  const home = await answer<{ page: { reference: Exact['reference']; document: DocumentSnapshot } }>(person.main('GET', `${site.root}/routes?path=%2F`));
  const exact = await answer<Exact>(person.main('GET', `/v1/content-revisions/${site.saved.revisionId}`));
  expect(home.page.document).toEqual(site.document);
  expect(exact.body.document).toEqual(site.document);
  expect(exact.reference).toMatchObject({ resourceId: site.page, variantId: site.variantId,
    revisionId: site.saved.revisionId, byteDigest: site.saved.byteDigest, sourceRevision: null,
    provenance: { kind: 'admitted-original-contribution-v1', rightsBasis: 'original-contribution',
      author: sessions.owner.actingSubject, scope: `content:draft:${site.page}` } });
  expect(home.page.reference.provenance).toEqual(exact.reference.provenance);
  await answer(person.main('GET', `/v1/content-revisions/${site.later.revisionId}`), 404);
  return home.page;
}
async function createSite(): Promise<Site> {
  const created = await answer<{ space: string; zone: string; zoneRevision: string }>(sessions.owner.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Original saved site', language: 'en', capabilities: ['zone'], actingSubject: sessions.owner.actingSubject }), 201);
  const root = `/v1/zones/${created.zone.slice(-36)}`;
  await answer(sessions.owner.main('PUT', `${root}/configuration`, { expectedHead: created.zoneRevision,
    prepareHomeDocument: true, actingSubject: sessions.owner.actingSubject }));
  const editor = await answer<{ configuration: { homeDocument: string }; draft: { variantId: string }; preview: { navigation: { revision: string } } }>(
    sessions.owner.main('GET', `${root}/showcase-editor?${acting(sessions.owner.actingSubject!)}`));
  const document = fromPlainText('Previous public original garden', 'blocks'), laterDocument = fromPlainText('Persistently saved private original garden', 'blocks');
  const base = { space: created.space, zone: created.zone, page: editor.configuration.homeDocument, root, variantId: editor.draft.variantId,
    navigationRevision: editor.preview.navigation.revision, document, laterDocument,
    publicationKey: randomUUID(), committedKey: randomUUID() };
  const saved = await answer<Saved>(sessions.owner.main('POST', '/v1/content-drafts', draftBody(base, sessions.owner.actingSubject!, document, null)), 201);
  const initial = { ...base, saved, later: saved };
  await answer(sessions.owner.main('POST', `${root}/site-publications`, await publicationBody(initial, sessions.owner.actingSubject!, saved), base.committedKey), 201);
  const later = await answer<Saved>(sessions.owner.main('POST', '/v1/content-drafts', draftBody(base, sessions.owner.actingSubject!, laterDocument, saved.revisionId)), 201);
  return { ...base, saved, later };
}
const fixtures = new Map<PersonaName, { sessions: PersonaSessions; site: Site }>();
beforeAll(async () => {
  await recording.prepare();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    sessions = await personaSessions('public');
    fixtures.set(name, { sessions, site: await createSite() });
  }
}, 300_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { for (const context of fixtures.values()) await context.sessions.close(); }
});
function fixture(name: PersonaName) {
  const context = fixtures.get(name)!;
  sessions = context.sessions;
  return context.site;
}
async function deny(site: Site, person: PersonaSession, subject: string, status = 403) {
  const readStatus = person.actingSubject ? 404 : 401;
  await answer(person.main('GET', `/v1/content-revisions/${site.later.revisionId}?${acting(subject)}`), readStatus);
  await answer(person.main('GET', `${site.root}/showcase-editor?${acting(subject)}`), readStatus);
  await answer(person.main('POST', '/v1/content-drafts', draftBody(site, subject, fromPlainText('Refused competing edit', 'blocks'), site.later.revisionId)), status);
  const body = await publicationBody(site, subject);
  await answer(person.main('POST', `${site.root}/site-publications`, body, site.publicationKey), status);
  await answer(person.main('POST', `${site.root}/site-publications`, body, site.publicationKey), status);
}
async function previewRetained(site: Site, person: PersonaSession, subject: string, provenance?: Record<string, unknown>) {
  const exact = await answer<Exact>(person.main('GET', `/v1/content-revisions/${site.later.revisionId}?${acting(subject)}`));
  expect(exact.body.document).toEqual(site.laterDocument);
  expect(exact.reference).toMatchObject({ resourceId: site.page, variantId: site.variantId,
    revisionId: site.later.revisionId, byteDigest: site.later.byteDigest, sourceRevision: null,
    provenance: { kind: 'admitted-original-contribution-v1', rightsBasis: 'original-contribution',
      author: sessions.owner.actingSubject, scope: `content:draft:${site.page}` } });
  if (provenance) expect(exact.reference.provenance).toEqual(provenance);
  return exact.reference.provenance;
}
async function recoveredEditor(site: Site, person: PersonaSession, subject: string) {
  const editor = await answer<{ draft: { revisionId: string; document: DocumentSnapshot } }>(
    person.main('GET', `${site.root}/showcase-editor?${acting(subject)}`));
  expect(editor.draft).toMatchObject({ revisionId: site.later.revisionId, document: site.laterDocument });
}
async function publishRetained(site: Site, person: PersonaSession, subject: string, provenance: Record<string, unknown>) {
  await answer(person.main('POST', `${site.root}/site-publications`, await publicationBody(site, subject)), 201);
  const exact = await answer<Exact>(sessions.visitor.main('GET', `/v1/content-revisions/${site.later.revisionId}`));
  expect(exact.body.document).toEqual(site.laterDocument);
  expect(exact.reference.provenance).toEqual(provenance);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${site.saved.revisionId}`), 404);
}
async function competingPublication(site: Site, owner: PersonaSession, subject: string, provenance: Record<string, unknown>) {
  const variantId = `urn:rezics:variant:${randomUUID()}`, document = fromPlainText('Competing public garden', 'blocks');
  // An independent variant keeps both selected cuts at their Content draft
  // heads; publishing an old revision of the same variant is correctly refused.
  const competing = await answer<Saved>(sessions.stranger.main('POST', '/v1/content-drafts', {
    ...draftBody({ page: site.page, variantId }, subject, document, null),
    language: { kind: 'tag', tag: 'fr', originalTag: 'fr' } }), 201);
  // Both commands select the same observed head. Delivering the second after
  // the winner proves stale refusal through HTTP; the owner regression controls
  // the separate post-pin ordering without relying on network timing.
  const staleBody = await publicationBody(site, subject), staleKey = randomUUID(), winnerKey = randomUUID();
  const winnerBody = { ...staleBody, pages: [{ page: site.page, variantId, revisionId: competing.revisionId,
    byteDigest: competing.byteDigest, contentEpoch: competing.sourcePosition.dataEpoch }] };
  const winner = await answer<{ revision: string; receipt: string; replayed: boolean }>(sessions.stranger.main(
    'POST', `${site.root}/site-publications`, winnerBody, winnerKey), 201);
  expect(winner.replayed).toBe(false);
  expect(winner.revision).not.toBe(staleBody.expectedHead);
  await answer(owner.main('POST', `${site.root}/site-publications`, staleBody, staleKey), 409)
    .then(problem => expect(problem).toMatchObject({ code: 'stale_zone_head' }));
  const bundle = await answer<{ page: { reference: Exact['reference']; document: DocumentSnapshot } }>(
    sessions.visitor.main('GET', `${site.root}/routes?path=%2F`));
  expect(bundle.page.document).toEqual(document);
  expect(bundle.page.reference).toMatchObject({ revisionId: competing.revisionId, byteDigest: competing.byteDigest,
    provenance: { author: subject, rightsBasis: 'original-contribution' } });
  const publicExact = await answer<Exact>(sessions.visitor.main('GET', `/v1/content-revisions/${competing.revisionId}`));
  expect(publicExact.body.document).toEqual(document);
  expect(publicExact.reference).toMatchObject({ byteDigest: competing.byteDigest, provenance: bundle.page.reference.provenance });
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${site.later.revisionId}`), 404);
  expect((await configuration(site)).revision).toBe(winner.revision);
  await answer(owner.main('POST', `${site.root}/site-publications`, staleBody, staleKey), 403)
    .then(problem => expect(problem).toMatchObject({ code: 'authority_denied' }));
  const afterRefusal = await answer<typeof bundle>(sessions.visitor.main('GET', `${site.root}/routes?path=%2F`));
  expect(afterRefusal.page).toEqual(bundle.page);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${site.later.revisionId}`), 404);
  await previewRetained(site, owner, subject, provenance);

  const recoveryBody = await publicationBody(site, subject), recoveryKey = randomUUID();
  expect(recoveryBody.expectedHead).toBe(winner.revision);
  const recovery = await answer<{ revision: string; receipt: string; replayed: boolean }>(owner.main(
    'POST', `${site.root}/site-publications`, recoveryBody, recoveryKey), 201);
  const retry = await answer(owner.main('POST', `${site.root}/site-publications`, recoveryBody, recoveryKey));
  expect(retry).toEqual({ ...recovery, replayed: true });
  const final = await answer<{ page: { reference: Exact['reference']; document: DocumentSnapshot } }>(
    sessions.visitor.main('GET', `${site.root}/routes?path=%2F`));
  expect(final.page.document).toEqual(site.laterDocument);
  expect(final.page.reference).toMatchObject({ revisionId: site.later.revisionId, byteDigest: site.later.byteDigest, provenance });
  const retained = await answer<Exact>(sessions.visitor.main('GET', `/v1/content-revisions/${site.later.revisionId}`));
  expect(retained.body.document).toEqual(site.laterDocument);
  expect(retained.reference).toMatchObject({ byteDigest: site.later.byteDigest, provenance });
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${site.saved.revisionId}`), 404);
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${competing.revisionId}`), 404);
  expect(await answer(sessions.stranger.main('POST', `${site.root}/site-publications`, winnerBody, winnerKey)))
    .toEqual({ ...winner, replayed: true });
  expect((await configuration(site)).revision).toBe(recovery.revision);
  const afterReplay = await answer<typeof final>(sessions.visitor.main('GET', `${site.root}/routes?path=%2F`));
  expect(afterReplay.page).toEqual(final.page);
  await recoveredEditor(site, owner, subject);
}
async function revokedController(name: 'member' | 'moderator') {
  const site = fixture(name), person = sessions[name], subject = sessions.owner.actingSubject!;
  const representationId = await invite(sessions.owner, subject, person);
  const provenance = await previewRetained(site, person, subject);
  // Saving under the admitted controlled Agent keeps that Agent's original author credit.
  site.laterDocument = fromPlainText(`Original garden saved by the ${name} controller`, 'blocks');
  site.later = await answer<Saved>(person.main('POST', '/v1/content-drafts', draftBody(site, subject, site.laterDocument, site.later.revisionId)), 201);
  const savedProvenance = await previewRetained(site, person, subject);
  expect(savedProvenance.author).toBe(provenance.author);
  const current = (await access(person, subject)).you.find(item => item.representationId === representationId)!;
  await removeController(sessions.owner, subject, representationId, current.generation);
  const previous = await publicBundle(site, person);
  await deny(site, person, subject);
  expect(await publicBundle(site, person)).toEqual(previous);
  // This session still has its independent Realm membership/moderation Agent.
  const membership = await answer<{ items: Array<{ realm: string }> }>(person.main('GET', `/v1/me/memberships?${acting(person.actingSubject!)}`));
  expect(membership.items.some(item => item.realm === sessions.realm)).toBe(true);
  if (name === 'moderator')
    await answer(person.main('GET', `/v1/realms/${sessions.realm.slice(-36)}/moderation?${acting(person.actingSubject!)}`));
  await invite(sessions.owner, subject, person);
  await previewRetained(site, person, subject, savedProvenance);
  await publishRetained(site, sessions.owner, subject, savedProvenance);
  await recoveredEditor(site, person, subject);
}
async function platformPage() {
  return answer<{ authorityEpoch: string; items: Array<{ id: string; permission: string; recipient: { principalId: string } }> }>(sessions.operator.main('GET',
    `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(sessions.operator.actingSubject!)}`));
}
async function mandate(site: Site) {
  const page = await platformPage(), principalId = page.items.find(item => item.permission === 'platform:grant')!.recipient.principalId;
  // The exact grant sorts after the broad grant, so authority cannot depend on UUID order.
  const lastId = page.items.map(item => item.id).sort().at(-1)!;
  const hex = (BigInt(`0x${lastId.replaceAll('-', '')}`) + 1n).toString(16).padStart(32, '0');
  const grantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const created = await answer<{ grant: Grant }>(sessions.operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', issuerSubject: sessions.operator.actingSubject, expectedAuthorityEpoch: page.authorityEpoch,
    action: 'create', grantId, permission: 'platform:resource:zone.edit', scopeId: `zone:edit:${site.zone}`,
    recipient: { principalId }, validUntil: null }));
  expect(created.grant).toMatchObject({ id: grantId, active: true, permission: 'platform:resource:zone.edit',
    scopeId: `zone:edit:${site.zone}`, recipient: { principalId } });
  return created.grant;
}
async function observer(name: 'visitor' | 'stranger') {
  const site = fixture(name), person = sessions[name], subject = sessions.owner.actingSubject!;
  const representationId = await invite(sessions.owner, subject, sessions.member);
  await previewRetained(site, sessions.member, subject);
  const current = (await access(sessions.member, subject)).you.find(item => item.representationId === representationId)!;
  await removeController(sessions.owner, subject, representationId, current.generation);
  await deny(site, sessions.member, subject);
  const previous = await publicBundle(site, person);
  await deny(site, person, person.actingSubject ?? subject, name === 'visitor' ? 401 : 403);
  await answer(person.main('POST', `${site.root}/site-publications`,
    await publicationBody(site, person.actingSubject ?? subject, site.saved), site.committedKey), name === 'visitor' ? 401 : 403);
  expect(await publicBundle(site, person)).toEqual(previous);
}

outcomeTest(revoked, 'visitor', () => qualify('visitor', () => observer('visitor')), recording);
outcomeTest(revoked, 'stranger', () => qualify('stranger', () => observer('stranger')), recording);
outcomeTest(revoked, 'member', () => qualify('member', () => revokedController('member')), recording);
outcomeTest(revoked, 'owner', () => qualify('owner', async () => {
  const site = fixture('owner'), owner = sessions.owner, subject = owner.actingSubject!;
  const recovery = await answer<{ agent: string }>(owner.main('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Original controller restoration recipient' }), 201);
  const recipient = { ...owner, actingSubject: recovery.agent };
  await invite(owner, subject, sessions.stranger);
  const original = (await access(owner, subject)).you[0]!;
  const provenance = await previewRetained(site, owner, subject);
  await removeController(owner, subject, original.representationId, original.generation);
  // The retained controller can read the configuration without borrowing the revoked account's authority.
  const previousOwner = sessions.owner;
  sessions.owner = { ...sessions.stranger, actingSubject: subject };
  const previous = await publicBundle(site, sessions.visitor);
  await deny(site, owner, subject);
  expect(await publicBundle(site, sessions.visitor)).toEqual(previous);
  await invite(sessions.stranger, subject, recipient);
  sessions.owner = previousOwner;
  await previewRetained(site, owner, subject, provenance);
  await publishRetained(site, owner, subject, provenance);
  await recoveredEditor(site, owner, subject);
  await competingPublication(site, owner, subject, provenance);
}), recording);
outcomeTest(revoked, 'moderator', () => qualify('moderator', () => revokedController('moderator')), recording);
outcomeTest(revoked, 'operator', () => qualify('operator', async () => {
  const site = fixture('operator'), operator = sessions.operator, subject = operator.actingSubject!;
  const grant = await mandate(site);
  const provenance = await previewRetained(site, operator, subject);
  await answer(operator.main('POST', '/v1/access/grant-changes', { profile: 'platform-grant-change-v1',
    issuerSubject: subject, expectedAuthorityEpoch: (await platformPage()).authorityEpoch,
    action: 'revoke', grantId: grant.id, expectedObjectGeneration: grant.generation }));
  const previous = await publicBundle(site, operator);
  await deny(site, operator, subject);
  expect(await publicBundle(site, operator)).toEqual(previous);
  const survivingGrant = await mandate(site);
  await previewRetained(site, operator, subject, provenance);
  // Removing one named Agent controller does not revoke another legitimate authority path.
  const recovery = await answer<{ agent: string }>(operator.main('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Operator controller restoration recipient' }), 201);
  const recipient = { ...operator, actingSubject: recovery.agent };
  await invite(operator, subject, sessions.stranger);
  const original = (await access(operator, subject)).you[0]!;
  await removeController(operator, subject, original.representationId, original.generation);
  const platform = await answer<{ groups: string[] }>(operator.main('GET', '/v1/me/platform-access'));
  expect(platform.groups).toContain('platform-admin');
  await deny(site, operator, subject);
  expect(await publicBundle(site, operator)).toEqual(previous);
  await previewRetained(site, recipient, recipient.actingSubject, provenance);
  await invite(sessions.stranger, subject, recipient);
  const retainedGrant = await answer<{ grant: { active: boolean; generation: string } }>(operator.main('GET',
    `/v1/access/grants/${survivingGrant.id}?profile=platform-grant-v1&issuerSubject=${encodeURIComponent(subject)}`));
  expect(retainedGrant.grant).toMatchObject({ active: true, generation: survivingGrant.generation });
  await previewRetained(site, operator, subject, provenance);
  await publishRetained(site, operator, subject, provenance);
  await recoveredEditor(site, operator, subject);
}), recording);

async function within<T>(milliseconds: number, part: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function qualify(name: PersonaName, proof: () => Promise<void>) {
  const started = Date.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The existing API proof owns 90 s; its production visit owns another 120 s.
    await within(90_000, 'API proof', proof);
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production visit', () => productionVisit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

const requestLabels = new AsyncLocalStorage<(path: string) => string>();
async function productionVisit(name: PersonaName) {
  const { site, sessions: people } = fixtures.get(name)!;
  const person = people[name], subject = person.actingSubject;
  const transport = (anonymous: boolean): typeof fetch => (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
    const label = requestLabels.getStore()?.(path);
    if (!label) throw new Error(`Production request has no label: ${path}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    // The public reader uses no bearer; personal requests always use this persona's bearer.
    return recording.session(name, anonymous ? people.visitor : person)(label, init?.method ?? 'GET', path, body, key);
  }) as typeof fetch;
  const main = browserMainApi('https://record.invalid', { fetcher: transport(false) });
  const publicMain = browserMainApi('https://record.invalid', { anonymous: true, fetcher: transport(true) });
  const named = <T,>(label: string, run: () => Promise<T>) => requestLabels.run(() => label, run);
  const publicFrame = realmFrameReads({ main: publicMain, keepProblem: false });
  let publicPresentation: ReturnType<typeof publicFrame.readCompletePresentation> | undefined;
  const publicPages = realmFrameReads({ main: publicMain, keepProblem: false, resolution: {
    readCompletePresentation: zone => publicPresentation ??= named('public-site-presentation',
      () => publicFrame.readCompletePresentation(zone)),
  } });
  const resolved = await named('public-site-address', () => publicPages.resolveSite(site.space.slice(-36), 'en'));
  if (resolved.kind !== 'site') return;
  const personalFrame = realmFrameReads({ main: publicMain, personal: main,
    actingSubject: subject ?? undefined, keepProblem: false });
  // The public home and its metadata share resolution. The metadata route and
  // the home's presentation can start together; the edit link follows the home.
  await Promise.all([
    named('public-home-route', () => personalFrame.readZoneRoute(resolved.zone, '/')),
    readIndependentZoneHome(independentZoneHomeBoundary({ production: {
      resolveSite: async () => resolved,
      readCompletePresentation: zone => subject
        ? named('public-home-presentation', () => personalFrame.readCompletePresentation(zone))
        : publicPresentation!,
    }, editorOpen: subject ? async (zone, actor) => named('public-home-editor', async () =>
      showcaseEditorAuthority(await readShowcaseEditor(main, zone, actor))) : null }), {
      space: site.space.slice(-36), locale: 'en', actingSubject: subject ?? undefined,
    }),
  ]);
  // manager() sends an anonymous visitor to sign-in before any management reads.
  if (!subject) return;
  const space = site.zone.slice(-36);
  async function render(prefix: 'management' | 'saved-preview') {
    const address = await named(`${prefix}-configuration`, () => readManagementAddress(main, space, 'en', subject!,
      (ref, locale) => named(`${prefix}-address`, () => suppliedManagementSite(main, subject!)(ref, locale))));
    // Layout and home share one address. The imported readers start the editor,
    // Zone and any lifecycle configuration together, as loadZoneManagementFrame does.
    const [authoring, lifecycle] = await Promise.all([
      requestLabels.run(path => path.includes('/showcase-editor') ? `${prefix}-editor` : `${prefix}-zone`,
        () => zoneAuthoringFromAddress(main, space, subject!, address)),
      named(`${prefix}-lifecycle-configuration`, () => zoneLifecycleFromAddress(main, space, subject!, address)),
    ]);
    return zoneManagementFrameFromReads(main, space, subject!, authoring, lifecycle, null);
  }
  const opened = await render('management');
  if (opened.authoring.kind !== 'ready') return;
  const preview = await loadSavedPreviewFrame({
    authoring: async () => (await render('saved-preview')).authoring,
    navigation: saved => named('saved-preview-navigation', () => loadCompleteZoneNavigation(main,
      saved.model.zoneId, subject, saved.model.state)),
    presentation: zone => named('saved-preview-theme-report', () => personalFrame.readPresentation(zone)),
    realmHeader: realm => named('saved-preview-realm-header', () => publicFrame.readRealmHeader(realm)),
    installedDigest, packages: { load: loadPackage, declarations: declaredData },
  }, { locale: 'en', homeName: 'Home', lookEnabled: false });
  if (preview.kind !== 'ready') return;
  const client = browserZoneAuthoring(main);
  let state = reduceEditor(opened.authoring.model.state, { type: 'edit',
    value: JSON.stringify(fromPlainText('Restored editor production garden', 'blocks')) });
  const choice = draftChoice(state, subject);
  const save = zoneCommandLane<typeof choice, Awaited<ReturnType<typeof client.saveDraft>>>({ ok: false, failure: 'unavailable' });
  const saved = await named('editor-save', () => save.submit(choice,
    (chosen, round) => commitCommand(round, key => client.saveDraft(draftWire(chosen), key))));
  if (!saved.ok) throw new Error(`Production save failed: ${saved.failure}`);
  state = reduceEditor(state, { type: 'saved', captured: choice.captured, savedValue: choice.savedValue,
    basis: saved.data, replayed: saved.data.replayed });
  const publication = publicationChoice(state);
  if (!publication) throw new Error('Production editor has no saved publication choice');
  const publish = zoneCommandLane<typeof publication, Awaited<ReturnType<typeof client.publish>>>({ ok: false, failure: 'unavailable' });
  const published = await named('editor-publication', () => publish.submit(publication,
    (chosen, round) => commitCommand(round, key => client.publish(chosen, subject, key, space))));
  if (!published.ok) throw new Error(`Production publication failed: ${published.failure}`);
}
