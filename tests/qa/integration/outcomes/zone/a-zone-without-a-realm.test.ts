import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AnswerRecordValidator, answerPersonas, answerRecord, type AnswerContract, type AnswerRecord } from '../../../../../scripts/api/answer-record.ts';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { browserZoneAuthoring, loadCompleteZoneNavigation } from '../../../../../apps/web/features/zone-editor/api.ts';
import { authoringModel, draftChoice, draftWire, publicationChoice } from '../../../../../apps/web/features/zone-editor/model.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import independent from '../../../../../scripts/qa/cases/outcomes/zone/a-zone-without-a-realm.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { settledWrite } from '../../../support/settled-write.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(180_000);
// The reopened operator cell records its reached refusal, without certifying it as proved.
// OutcomeRecorder still validates every request and owns each proof's lifecycle.
const recording = new OutcomeRecorder(independent, { directory: '.temp/standalone-zone-validation' });
const captured = Object.fromEntries(answerPersonas.map(name => [name, []])) as AnswerRecord['personas'];
const completedVisits = new Set<PersonaName>();
let validator: AnswerRecordValidator;
let operatorZoneRefused = false;
let persona: PersonaName;
async function capture(name: PersonaName, person: PersonaSession, label: string, ...args: Parameters<PersonaSession['main']>) {
  const response = await recording.session(name, person)(label, ...args);
  const [method, requestPath, body] = args;
  captured[name].push({ label, operationId: validator.operationId(method, requestPath), method, path: requestPath,
    ...(body === undefined ? {} : { body }), status: response.status,
    answer: await response.clone().json() as unknown, headers: Object.fromEntries(response.headers.entries()) });
  return response;
}
const sample = (person: PersonaSession, label: string, ...args: Parameters<PersonaSession['main']>) =>
  capture(persona, person, label, ...args);
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
const visitAnswers: { persona: PersonaName; label: string; method: string; path: string; body?: unknown; key?: string; status: number; answer: unknown }[] = [];
const fixtures = new Map<PersonaName, { sessions: PersonaSessions; site: Site }>();
beforeAll(async () => {
  await recording.prepare();
  validator = new AnswerRecordValidator(JSON.parse(await readFile('generated/openapi/main/public.json', 'utf8')) as AnswerContract);
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    sessions = await personaSessions('public');
    fixtures.set(name, { sessions, site: await createSite() });
  }
}, 420_000);
afterAll(async () => {
  try {
    await mkdir('.temp/standalone-zone-visit', { recursive: true });
    await writeFile(`.temp/standalone-zone-visit/${process.env.REZICS_QA_RUN_ID ?? 'local'}.json`, JSON.stringify(visitAnswers, null, 2));
    if (process.env.OUTCOME_RECORD_DIR && completedVisits.size === answerPersonas.length) {
      const directory = resolve(process.env.OUTCOME_RECORD_DIR);
      if (!directory.startsWith(`${resolve('.temp')}/`)) throw new Error('Recording must stay under .temp/');
      const record = answerRecord(independent.rowId, captured);
      validator.validate(record);
      const destination = resolve(directory, `${record.row}.json`);
      await mkdir(resolve(destination, '..'), { recursive: true });
      await writeFile(destination, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    }
  } finally { await sessions?.close(); }
});
function fixture(name: PersonaName) {
  persona = name;
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
  return answer<Saved>(settledWrite(sessions.owner.main, 'POST', '/v1/content-drafts',
    draftBody(site, sessions.owner, document, expectedHead)), 201);
}
async function configuration(site: Site, person = sessions.owner, label?: string) {
  const main = label ? (...args: Parameters<PersonaSession['main']>) => sample(person, label, ...args) : person.main;
  return answer<{ revision: string; configuration: { defaultRealm: string | null } }>(
    main('GET', `${path(site)}/configuration?${acting(person)}`));
}
async function createSite(): Promise<Site> {
  const created = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(
    settledWrite(sessions.owner.main, 'POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Independent original site',
      language: 'en', capabilities: ['zone'], actingSubject: sessions.owner.actingSubject }), 201);
  const root = `/v1/zones/${short(created.zone)}`;
  await answer(settledWrite(sessions.owner.main, 'PUT', `${root}/configuration`, {
    expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject: sessions.owner.actingSubject }));
  const editor = await answer<{ configuration: { homeDocument: string }; draft: { variantId: string }; preview: { navigation: { revision: string } } }>(
    sessions.owner.main('GET', `${root}/showcase-editor?${acting(sessions.owner)}`));
  const site = { ...created, page: editor.configuration.homeDocument, variantId: editor.draft.variantId,
    navigationRevision: editor.preview.navigation.revision, document: fromPlainText('Original published garden', 'blocks') };
  const saved = await answer<Saved>(settledWrite(sessions.owner.main, 'POST', '/v1/content-drafts',
    draftBody(site, sessions.owner, site.document, null)), 201);
  return { ...site, saved };
}
async function publicationBody(site: Site, person: PersonaSession, saved = site.saved) {
  return { expectedHead: (await configuration(site)).revision, actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    routesRevision: site.navigationRevision, navigationRevision: site.navigationRevision,
    pages: [{ page: site.page, variantId: site.variantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch }] };
}
async function publish(site: Site, person = sessions.owner, saved = site.saved, label?: string) {
  const main = label ? (...args: Parameters<PersonaSession['main']>) => sample(person, label, ...args)
    : (...[method, requestPath, body, key]: Parameters<PersonaSession['main']>) =>
      settledWrite(person.main, method, requestPath, body, key);
  return answer<{ revision: string; themeRevision: string; pages: Array<{ revisionId: string }> }>(
    main('POST', `${path(site)}/site-publications`, await publicationBody(site, person, saved)), 201);
}
async function publicCut(site: Site, person: PersonaSession, saved = site.saved, document = site.document, label = 'published') {
  const home = await answer<{ realm: string | null; page: { reference: Exact['reference']; document: DocumentSnapshot } }>(
    sample(person, `${label}-home`, 'GET', `${path(site)}/routes?path=%2F`));
  expect(home.realm).toBeNull();
  expect(home.page.document).toEqual(document);
  const exact = await answer<Exact>(sample(person, `${label}-content`, 'GET', exactPath(saved)));
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
  await answer(sample(person, 'private-content-refused', 'GET', `${exactPath(saved)}?${acting(person)}`), readStatus);
  await answer(sample(person, 'editor-refused', 'GET', `${path(site)}/showcase-editor?${acting(person)}`), readStatus);
  await answer(sample(person, 'draft-write-refused', 'POST', '/v1/content-drafts',
    draftBody(site, person, fromPlainText('Unauthorized replacement', 'blocks'), saved.revisionId)), status);
  await answer(sample(person, 'publication-refused', 'POST', `${path(site)}/site-publications`, await publicationBody(site, person, saved)), status);
}
async function reader(name: Exclude<PersonaName, 'owner' | 'operator'>) {
  const site = fixture(name), person = sessions[name];
  await publish(site);
  const provenance = await publicCut(site, person);
  const later = await save(site, fromPlainText('Private garden draft', 'blocks'), site.saved.revisionId);
  await answer(sample(person, 'private-draft-hidden', 'GET', exactPath(later)), 404);
  await denied(site, person, later, name === 'visitor' ? 401 : 403);
  await pageReads(site, person);
  expect(await publicCut(site, person, site.saved, site.document, 'unchanged')).toEqual(provenance);
}
async function platformPage(label: string) {
  return answer<{ authorityEpoch: string; items: Array<{ id: string; permission: string; scopeId: string; recipient: { principalId: string } }> }>(
    sample(sessions.operator, label, 'GET', `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(sessions.operator.actingSubject!)}`));
}
async function exactMandate(site: Site) {
  const page = await platformPage('exact-mandate-basis');
  const principalId = page.items.find(item => item.permission === 'platform:grant')!.recipient.principalId;
  // The exact grant sorts after the broad grant, so authority cannot depend on UUID order.
  const lastId = page.items.map(item => item.id).sort().at(-1)!;
  const hex = (BigInt(`0x${lastId.replaceAll('-', '')}`) + 1n).toString(16).padStart(32, '0');
  const grantId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const created = await answer<{ grant: { id: string; generation: string } }>(sample(sessions.operator, 'exact-mandate-granted', 'POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', issuerSubject: sessions.operator.actingSubject,
    expectedAuthorityEpoch: page.authorityEpoch, action: 'create', grantId,
    permission: 'platform:resource:zone.edit', scopeId: `zone:edit:${site.zone}`, recipient: { principalId }, validUntil: null }));
  expect(created.grant).toMatchObject({ id: grantId, active: true, permission: 'platform:resource:zone.edit',
    scopeId: `zone:edit:${site.zone}`, recipient: { principalId } });
  return created;
}

// The standalone home and its metadata share these cached reads. There is no
// mount index on this visit; presentation pages only when navigation has a next cut.
async function pageReads(site: Site, person: PersonaSession) {
  const viewer: Record<string, string> = person.actingSubject ? { actingSubject: person.actingSubject } : {};
  await answer(sample(sessions.visitor, 'page-address', 'GET',
    `/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key: short(site.zone) })}`));
  await answer(sample(sessions.visitor, 'page-types', 'GET', '/v1/types'));
  if (person.actingSubject) {
    await answer(sample(person, 'page-session-agent', 'GET', '/v1/me/session-agent'));
    await answer(sample(person, 'page-language-preferences', 'GET',
      `/v1/me/person-preferences?actingSubject=${encodeURIComponent(person.actingSubject)}`));
    await answer(sample(person, 'page-acting-contexts', 'GET', '/v1/me/acting-contexts?task=work.create'));
    await answer(sample(person, 'page-agents', 'GET', '/v1/me/agents?languages=en'));
    await answer(sample(person, 'page-agent-profile', 'GET',
      `/v1/agents/${short(person.actingSubject)}?actingSubject=${encodeURIComponent(person.actingSubject)}`));
    await answer(sample(person, 'page-editor-link', 'GET',
      `${path(site)}/showcase-editor?${new URLSearchParams(viewer)}`),
    persona === 'owner' || persona === 'operator' ? 200 : 404);
  }
  await answer(sample(person, 'page-home-route', 'GET',
    `${path(site)}/routes?${new URLSearchParams({ ...viewer, path: '/' })}`));
  let page = await answer<{ navigationNext: string | null }>(sample(person, 'page-presentation', 'GET',
    `${path(site)}/presentation${person.actingSubject ? `?${new URLSearchParams(viewer)}` : ''}`));
  let continuation = 0;
  while (page.navigationNext) {
    page = await answer(sample(person, `page-presentation-continuation-${++continuation}`, 'GET',
      `${path(site)}/presentation?${new URLSearchParams({ ...viewer, after: page.navigationNext })}`));
  }
}

outcomeTest(independent, 'visitor', () => qualify('visitor', () => reader('visitor')), recording);
outcomeTest(independent, 'stranger', () => qualify('stranger', () => reader('stranger')), recording);
outcomeTest(independent, 'member', () => qualify('member', () => reader('member')), recording);
async function ownerProof() {
  const site = fixture('owner'), owner = sessions.owner;
  expect((await configuration(site, owner, 'standalone-configuration')).configuration.defaultRealm ?? null).toBeNull();
  expect(await answer(sample(owner, 'unpublished-home', 'GET', `${path(site)}/routes?path=%2F`))).not.toHaveProperty('page');
  await answer(sample(sessions.visitor, 'unpublished-content-hidden', 'GET', exactPath(site.saved)), 404);
  const preview = await answer<Exact>(sample(owner, 'draft-preview', 'GET', `${exactPath(site.saved)}?${acting(owner)}`));
  expect(preview.body.document).toEqual(site.document);
  const first = await publish(site, owner, site.saved, 'first-publication');
  const provenance = await publicCut(site, owner);
  const document = fromPlainText('Exact replacement garden', 'blocks');
  const later = await save(site, document, site.saved.revisionId);
  expect((await configuration(site, owner, 'published-configuration')).revision).toBe(first.revision);
  await answer(sample(sessions.visitor, 'replacement-content-hidden', 'GET', exactPath(later)), 404);
  expect((await answer<Exact>(sample(owner, 'replacement-preview', 'GET', `${exactPath(later)}?${acting(owner)}`))).body.document).toEqual(document);
  await answer(sample(owner, 'stale-draft-refused', 'POST', '/v1/content-drafts', draftBody(site, owner, site.document, site.saved.revisionId)), 409);
  await publicCut(site, sessions.visitor, site.saved, site.document, 'visitor-before-replacement');
  const second = await publish(site, owner, later, 'replacement-publication');
  expect(second.revision).not.toBe(first.revision);
  await publicCut(site, sessions.visitor, later, document, 'visitor-replacement');
  expect(preview.reference.provenance).toEqual(provenance);
  await answer(sample(sessions.visitor, 'withdrawn-content-hidden', 'GET', exactPath(site.saved)), 404);
  const editor = await answer<{ draft: { revisionId: string; document: DocumentSnapshot } }>(
    sample(owner, 'saved-editor', 'GET', `${path(site)}/showcase-editor?${acting(owner)}`));
  expect(editor.draft).toMatchObject({ revisionId: later.revisionId, document });
  await pageReads(site, owner);
}
outcomeTest(independent, 'owner', () => qualify('owner', ownerProof), recording);
outcomeTest(independent, 'moderator', () => qualify('moderator', () => reader('moderator')), recording);
async function operatorProof() {
  const site = fixture('operator'), operator = sessions.operator;
  await publish(site);
  const provenance = await publicCut(site, operator);
  const laterDocument = fromPlainText('Owner saved for later operator publication', 'blocks');
  const later = await save(site, laterDocument, site.saved.revisionId);
  expect((await platformPage('broad-mandate')).items).toContainEqual(expect.objectContaining({
    permission: 'platform:resource:zone.edit', scopeId: 'zone:edit:*' }));
  await denied(site, operator, later);
  await exactMandate(site);
  expect((await answer<Exact>(sample(operator, 'mandated-preview', 'GET', `${exactPath(later)}?${acting(operator)}`))).body.document).toEqual(laterDocument);
  await publish(site, operator, later, 'mandated-publication');
  const credit = await publicCut(site, sessions.visitor, later, laterDocument, 'visitor-mandated');
  expect(credit.author).toBe(provenance.author);
  const editor = await answer<{ draft: { revisionId: string; document: DocumentSnapshot } }>(
    sample(operator, 'mandated-editor', 'GET', `${path(site)}/showcase-editor?${acting(operator)}`));
  expect(editor.draft).toMatchObject({ revisionId: later.revisionId, document: laterDocument });
  await pageReads(site, operator);
}
outcomeTest(independent, 'operator', () => qualify('operator', operatorProof), recording);


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
    // The API proof keeps its original 60 s; the production visit owns another 120 s.
    await within(60_000, 'API proof', proof);
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production visit', () => productionVisit(fixtures.get(name)!.site, sessions[name]));
    completedVisits.add(name);
    if (name === 'operator' && independent.cells.operator?.state === 'pending' && operatorZoneRefused)
      throw new Error('Exact-mandated operator: showcase-editor 200, Zone read 404; production stops before editor authority');
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

const requestLabels = new AsyncLocalStorage<(method: string, path: string) => string>();
async function productionVisit(site: Site, person: PersonaSession) {
  // manager redirects a visitor to sign-in before loadZoneAuthoring or its layout reads.
  if (!person.actingSubject) return;
  const currentPersona = persona;
  const observe = (caller: PersonaSession) => async (label: string, ...args: Parameters<PersonaSession['main']>) => {
    const response = await capture(currentPersona, caller, label, ...args);
    const [method, requestPath, body, key] = args;
    visitAnswers.push({ persona: currentPersona, label, method, path: requestPath,
      ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { key }),
      status: response.status, answer: await response.clone().json() as unknown });
    return response;
  };
  const recorded = observe(person);
  const publicRecorded = observe(sessions.visitor);
  const read = async <T = unknown,>(label: string, requestPath: string, publicRead = false) => {
    const response = await (publicRead ? publicRecorded : recorded)(label, 'GET', requestPath);
    return { status: response.status, data: await response.json() as T };
  };
  const main = browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const requestPath = url.pathname.replace(/^\/api\/main/, '') + url.search;
    const method = init?.method ?? 'GET';
    const label = requestLabels.getStore()?.(method, requestPath);
    if (!label) throw new Error(`Production request has no label: ${method} ${requestPath}`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    return recorded(label, method, requestPath, body, key);
  }) as typeof fetch });
  const named = <T,>(label: string, run: () => Promise<T>) => requestLabels.run(() => label, run);
  const client = browserZoneAuthoring(main);

  async function authoring(prefix: 'management' | 'saved-preview') {
    const configuration = await read<{ configuration: { space: string } }>(`${prefix}-configuration`, `${path(site)}/configuration?${acting(person)}`);
    // resolveZoneManagementAddress falls back to the supplied Space key on denied/missing configuration.
    if (![200, 403, 404].includes(configuration.status)) return null;
    const key = configuration.status === 200
      ? short(configuration.data.configuration.space as string) : short(site.zone);
    const address = await read<{ status: string; capabilities?: { zone?: string } }>(`${prefix}-address`, `/v1/addresses/resolve?${new URLSearchParams({ scope: 'space', key })}`, true);
    if (address.status !== 200 || address.data.status !== 'resolved' || !address.data.capabilities?.zone) return null;
    await read(`${prefix}-site-presentation`, `${path(site)}/presentation`, true);
    // The layout's lifecycle read reuses the configuration binding, or reads it after the public site resolves.
    const [editor, zone] = await Promise.all([
      read<{ preview: { presentation: { official?: { theme?: string } } } }>(`${prefix}-editor`, `${path(site)}/showcase-editor?${acting(person)}`),
      read(`${prefix}-zone`, `${path(site)}?${acting(person)}`),
      ...(configuration.status === 200 ? [] : [read(`${prefix}-lifecycle-configuration`, `${path(site)}/configuration?${acting(person)}`)]),
    ]);
    if (currentPersona === 'operator' && editor.status === 200 && zone.status === 404) operatorZoneRefused = true;
    if (editor.status !== 200 || zone.status !== 200) return null;
    const model = authoringModel(editor.data, zone.data, short(site.zone), 'Independent original site');
    if (!model) throw new Error('Production authoring model could not open the recorded reads');
    return { model, preview: editor.data.preview };
  }
  const opened = await authoring('management');
  const savedPreview = await authoring('saved-preview');
  if (!opened || !savedPreview) return;
  const navigation = await requestLabels.run((_method, requestPath) => {
    if (requestPath.startsWith(`${path(site)}?`)) return 'saved-preview-navigation';
    if (requestPath.includes('/revisions/')) return `saved-preview-navigation-${new URL(requestPath, 'https://record.invalid').searchParams.get('after')}`;
    if (requestPath.startsWith('/v1/collections/')) return `saved-preview-mount-name-${requestPath.split('/')[3]}`;
    if (requestPath.startsWith('/v1/works/')) return `saved-preview-mount-work-${requestPath.split('/')[3]}`;
    throw new Error(`Unlabelled navigation request: ${requestPath}`);
  }, () => loadCompleteZoneNavigation(main, short(site.zone), person.actingSubject!, savedPreview.model.state));
  if (!navigation.ok) throw new Error(`Production saved navigation failed: ${navigation.failure}`);
  // These Blocks have no mounts, Showcase sources or media. Saved composition is
  // in showcase-editor; loadSavedPreviewFrame adds a public report only for an official theme.
  if (savedPreview.preview.presentation.official?.theme) {
    await read('saved-preview-theme-report', `${path(site)}/presentation?${acting(person)}`);
  }

  const state = opened.model.state;
  const choice = draftChoice({ ...state, value: JSON.stringify(fromPlainText('Saved production garden', 'blocks')) },
    person.actingSubject);
  const saved = await named('editor-save', () => client.saveDraft(draftWire(choice), randomUUID()));
  if (!saved.ok) throw new Error(`Production save failed: ${saved.failure}`);
  const reopened = await requestLabels.run((_method, requestPath) => requestPath.includes('/showcase-editor')
    ? 'editor-reopen-draft' : 'editor-reopen-heads', () => client.readDraft(short(site.zone), person.actingSubject!));
  if (!reopened.ok) throw new Error(`Production reopen failed: ${reopened.failure}`);
  await named('editor-stale-save', () => client.saveDraft(draftWire(choice), randomUUID()));
  const publication = publicationChoice({ ...state, value: choice.savedValue, savedValue: choice.savedValue,
    expectedHead: saved.data.revisionId, basis: saved.data });
  if (!publication) throw new Error('Production editor has no publishable saved choice');
  const published = await named('editor-publication', () => client.publish(publication, person.actingSubject!, randomUUID(), short(site.zone)));
  if (!published.ok) throw new Error(`Production publication failed: ${published.failure}`);
}
