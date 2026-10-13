import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import revoked from '../../../../../scripts/qa/cases/outcomes/zone/publish-after-editor-revocation-revoked-editors.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
interface Saved { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }
interface Site { zone: string; page: string; root: string; variantId: string; navigationRevision: string; saved: Saved; later: Saved;
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
  const created = await answer<{ zone: string; zoneRevision: string }>(sessions.owner.main('POST', '/v1/spaces', {
    profile: 'space-zone-v1', name: 'Original saved site', language: 'en', capabilities: ['zone'], actingSubject: sessions.owner.actingSubject }), 201);
  const root = `/v1/zones/${created.zone.slice(-36)}`;
  await answer(sessions.owner.main('PUT', `${root}/configuration`, { expectedHead: created.zoneRevision,
    prepareHomeDocument: true, actingSubject: sessions.owner.actingSubject }));
  const editor = await answer<{ configuration: { homeDocument: string }; draft: { variantId: string }; preview: { navigation: { revision: string } } }>(
    sessions.owner.main('GET', `${root}/showcase-editor?${acting(sessions.owner.actingSubject!)}`));
  const document = fromPlainText('Previous public original garden', 'blocks'), laterDocument = fromPlainText('Persistently saved private original garden', 'blocks');
  const base = { zone: created.zone, page: editor.configuration.homeDocument, root, variantId: editor.draft.variantId,
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

outcomeTest(revoked, 'visitor', () => observer('visitor'));
outcomeTest(revoked, 'stranger', () => observer('stranger'));
outcomeTest(revoked, 'member', () => revokedController('member'));
outcomeTest(revoked, 'owner', async () => {
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
  // The single public publication command exposes its receipt only after switching.
  // No public pin observation or interleaving control can establish the lead's post-pin race.
  throw new Error('Public-HTTP setup unavailable: cannot observe the Content pin before the final Zone bundle switch; sequential revocation/restoration above is exercised');
});
outcomeTest(revoked, 'moderator', () => revokedController('moderator'));
outcomeTest(revoked, 'operator', async () => {
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
});
