import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { readLifecyclePreview, readLifecyclePublic } from '../../../../../apps/web/features/zone-editor/zone-lifecycle-recorded-page.ts';
import { browserZoneLifecycle } from '../../../../../apps/web/features/zone-editor/api.ts';
import { readManagementAddress, readZoneRecoveryReturnAddress, suppliedManagementSite,
  zoneAuthoringFromAddress, zoneLifecycleFromAddress, zoneManagementFrameFromReads } from '../../../../../apps/web/features/zone-editor/authoring-reads.ts';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import lifecycle from '../../../../../scripts/qa/cases/outcomes/zone/lifecycle.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(180_000);
const recording = new OutcomeRecorder(lifecycle);
const fileWall = setTimeout(() => { throw new Error('Zone lifecycle file exceeded 480 s'); }, 480_000);
const requestLabels = new AsyncLocalStorage<(method: string, path: string) => string>();
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
  await recording.prepare();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    sessions = await personaSessions('public');
    fixtures.set(name, { sessions, site: await createSite() });
  }
}, 240_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});
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

async function within<T>(milliseconds: number, phase: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function qualify(name: PersonaName, proof: () => Promise<void>) {
  const started = Date.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The existing API proof owns 60 s; recording the production visit owns another 120 s.
    await within(60_000, 'API proof', proof);
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production visit', () => productionVisit(name, fixtures.get(name)!.site, sessions[name]));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

async function productionVisit(name: PersonaName, site: Site, person: PersonaSession) {
  const zoneId = site.zone.slice(-36);
  const space = (await answer<{ configuration: { space: string } }>(sessions.owner.main('GET', `${site.root}/configuration?${acting(sessions.owner)}`))).configuration.space.slice(-36);
  const actingSubject = person.actingSubject ?? undefined;
  const recorded = recording.session(name, person);
  const client = (anonymous = false) => browserMainApi('https://record.invalid', { anonymous, fetcher: (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
    const method = init?.method ?? 'GET';
    const label = requestLabels.getStore()?.(method, path);
    if (!label) throw new Error(`Production request has no label: ${method} ${path}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    return (anonymous ? recording.session(name, sessions.visitor) : recorded)(label, method, path, body, key);
  }) as typeof fetch });
  async function publicPage(prefix: string) {
    return requestLabels.run((_method, path) => `${prefix}-${path.startsWith('/v1/addresses/') ? 'address'
      : path.includes('/showcase-editor') ? 'editor' : path.includes('/presentation') ? 'presentation' : path.endsWith('/join-page') ? 'private-landing' : 'private-space'}`,
      () => readLifecyclePublic(client(true), client(), (async input => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
        return recording.session(name, path.includes('actingSubject=') ? person : sessions.visitor)(
          requestLabels.getStore()!('GET', path), 'GET', path);
      }) as typeof fetch, space, actingSubject));
  }
  await publicPage('public');
  // manager sends the signed-out visitor to sign-in before any management read.
  if (!actingSubject) return;
  const main = client();
  const named = <T,>(label: string, run: () => Promise<T>) => requestLabels.run(() => label, run);
  const lifecycleClient = browserZoneLifecycle(main);

  async function sessionReads(prefix: string) {
    // readSession starts discovery, the language-specific Agent list and selection together.
    await Promise.all([
      named(`${prefix}-acting-contexts`, () => main.v1.me['acting-contexts'].get({ query: { task: 'work.create' } })),
      named(`${prefix}-agents`, () => main.v1.me.agents.get({ query: { languages: 'en' } })),
      named(`${prefix}-session-agent`, () => main.v1.me['session-agent'].get()).then(() =>
        named(`${prefix}-language-preferences`, () => main.v1.me['person-preferences'].get({ query: { actingSubject } }))),
    ]);
    await named(`${prefix}-agent-profile`, () => main.v1.agents({ id: actingSubject.slice(-36) }).get({ query: { actingSubject } }));
  }
  async function render(prefix: string, key = zoneId) {
    await sessionReads(prefix);
    // The production frame shares address admission and starts authoring and
    // lifecycle reads together, including the retained frame after retirement.
    const address = await requestLabels.run((_method, path) => {
      if (path.startsWith('/v1/addresses/resolve')) return `${prefix}-address`;
      if (path.includes('/configuration')) return `${prefix}-binding-configuration`;
      throw new Error(`Unlabelled management admission: ${path}`);
    }, () => readManagementAddress(main, key, 'en', actingSubject, suppliedManagementSite(main, actingSubject)));
    const [authoring, lifecycleRead] = await Promise.all([
      requestLabels.run((_method, path) => {
        if (path.includes('/showcase-editor')) return `${prefix}-editor`;
        if (path.startsWith(`/v1/zones/${zoneId}?`)) return `${prefix}-zone`;
        throw new Error(`Unlabelled authoring read: ${path}`);
      }, () => zoneAuthoringFromAddress(main, key, actingSubject, address)),
      named(`${prefix}-lifecycle-configuration`, () => zoneLifecycleFromAddress(main, key, actingSubject, address)),
    ]);
    const loaded = await zoneManagementFrameFromReads(main, key, actingSubject, authoring, lifecycleRead, null);
    if (loaded.authoring.kind === 'ready') await requestLabels.run((_method, path) => `${prefix}-preview-${path.split('?')[0]!.split('/').slice(2).join('-')}`,
      () => readLifecyclePreview(main, loaded, 'en', actingSubject!));
    if (loaded.lifecycle.kind !== 'ready') return null;
    const lifecycle = loaded.lifecycle;
    // The lifecycle page validates its return address after the shared frame.
    if (prefix !== 'recovered') await named(`${prefix}-return-address`, () => readZoneRecoveryReturnAddress(main,
      lifecycle.returnAddress, lifecycle, actingSubject));
    return lifecycle;
  }
  const opened = await render('lifecycle');
  if (!opened) return;
  const retireBody = { expectedHead: opened.revision, actingSubject }, retireKey = randomUUID();
  const retired = await named('lifecycle-retire', () => lifecycleClient.retire(zoneId, retireBody, retireKey));
  await named('lifecycle-retire-replay', () => lifecycleClient.retire(zoneId, retireBody, retireKey));
  await named('lifecycle-stale', () => lifecycleClient.retire(zoneId, retireBody, randomUUID()));
  if (!retired.ok) return;
  await publicPage('retired-public');
  // Retirement replaces the page with the stable UUID lifecycle entry.
  const retained = await render('retired');
  if (!retained) return;
  const recovered = await named('lifecycle-recover', () => lifecycleClient.recover(zoneId,
    { expectedHead: retained.revision, actingSubject }, randomUUID()));
  if (!recovered.ok) return;
  // Recovery replaces the page with the bound Space's home editor.
  await render('recovered', retained.returnAddress);
  await publicPage('recovered-public');
}

outcomeTest(lifecycle, 'visitor', () => qualify('visitor', () => reader('visitor')), recording);
outcomeTest(lifecycle, 'stranger', () => qualify('stranger', () => reader('stranger')), recording);
outcomeTest(lifecycle, 'member', () => qualify('member', () => reader('member')), recording);
outcomeTest(lifecycle, 'owner', () => qualify('owner', () => steward('owner')), recording);
outcomeTest(lifecycle, 'moderator', () => qualify('moderator', () => reader('moderator')), recording);
outcomeTest(lifecycle, 'operator', () => qualify('operator', () => steward('operator')), recording);
