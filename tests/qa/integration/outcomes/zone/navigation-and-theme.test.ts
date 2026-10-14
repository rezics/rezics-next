import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { realmFrameReads, zonePresentationReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import { browserZoneAuthoring, browserZoneNavigation, browserZoneTheme, loadZoneNavigation } from '../../../../../apps/web/features/zone-editor/api.ts';
import { resolveZoneManagementAddress } from '../../../../../apps/web/features/zone-editor/management-address.ts';
import { authoringModel } from '../../../../../apps/web/features/zone-editor/model.ts';
import { readMembership } from '../../../../../apps/web/features/realm/membership-state.ts';
import { settle } from '../../../../../apps/web/features/manage/read.ts';
import { zoneThemePatch } from '../../../../../apps/web/features/zone-editor/theme.ts';
import row from '../../../../../scripts/qa/cases/outcomes/zone/navigation-and-theme.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
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
setDefaultTimeout(180_000);
const fileWall = setTimeout(() => { throw new Error('Navigation and theme file exceeded 480 s'); }, 480_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(row);
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => person.actingSubject
  ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  await recording.prepare();
  sessions = await personaSessions('public');
}, 180_000);
afterAll(async () => {
  try {
    await recording.publish();
    await mkdir('.temp/navigation-theme-visit', { recursive: true });
    await writeFile(`.temp/navigation-theme-visit/${process.env.REZICS_QA_RUN_ID ?? 'local'}.json`, JSON.stringify(visitRequests, null, 2));
  }
  finally { clearTimeout(fileWall); await sessions?.close(); }
});

let fixture: Promise<Awaited<ReturnType<typeof prepareSite>>> | undefined;
const site = () => fixture ??= prepareSite();

async function prepareSite() {
  const owner = sessions.owner;
  const created = await answer<{ space: string; zone: string; zoneRevision: string; navigationRevision: string }>(
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
  return { space: created.space, path, homeDocument, page, draft, publishedDocument, draftDocument, draftBody, publishBody, body, key, receipt,
    collection, mounted, draftNavigation, publishedPresentation, draftPresentation, configured, unknownPayload };
}

async function publicBundle(f: Awaited<ReturnType<typeof site>>, person: PersonaSession,
  sample?: ReturnType<typeof recording.session>) {
  const delivered = await answer<Presentation>(sample ? sample('published-presentation', 'GET', `${f.path}/presentation`)
    : person.main('GET', `${f.path}/presentation`));
  expect(delivered.presentation).toEqual(f.publishedPresentation);
  expect(delivered.renderTokens).toMatchObject(f.publishedPresentation.tokens);
  expect(delivered.navigation.map(item => item.segment)).toEqual(['published-link']);
  expect(delivered.home).toMatchObject({ document: f.publishedDocument, reference: {
    revisionId: f.page.revisionId, provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject },
  } });
  await answer(sample ? sample('published-index-empty', 'GET', `${f.path}/routes?path=%2Fpublished-link`)
    : person.main('GET', `${f.path}/routes?path=%2Fpublished-link`));
  await answer(sample ? sample('unpublished-route-refused', 'GET', `${f.path}/routes?path=%2Fdraft-link`)
    : person.main('GET', `${f.path}/routes?path=%2Fdraft-link`), 404);
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
  const sample = proofRequests(person);
  if (name === 'visitor') await supportingReads(sample, f);
  const before = await publicBundle(f, person, sample);
  if (name !== 'visitor') {
    await answer(sample('draft-configuration-refused', 'GET', `${f.path}/configuration${query(person)}`), 404);
    await answer(sample('showcase-editor', 'GET', `${f.path}/showcase-editor${query(person)}`), 404);
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

outcomeTest(row, 'visitor', () => qualify('visitor', () => view('visitor')), recording);
outcomeTest(row, 'stranger', () => qualify('stranger', () => view('stranger')), recording);
outcomeTest(row, 'member', () => qualify('member', () => view('member')), recording);
outcomeTest(row, 'moderator', () => qualify('moderator', () => view('moderator')), recording);
outcomeTest(row, 'operator', () => qualify('operator', () => view('operator')), recording);
outcomeTest(row, 'owner', () => qualify('owner', async () => {
  const prepared = await site();
  const owner = sessions.owner;
  const sample = proofRequests(owner);
  // Keep the public baseline for the other proofs while recording this publication's own draft chain.
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const save = async (label: string, document: DocumentSnapshot, expectedHead: string | null) => {
    const body = { ...prepared.draftBody(document, expectedHead), variantId };
    const saved = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      sample(label, 'POST', '/v1/content-drafts', body), 201);
    expect(body.resourceId).toBe(prepared.homeDocument);
    return { page: body.resourceId, variantId, revisionId: saved.revisionId,
      byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch } satisfies Page;
  };
  const first = await save('save-home-draft', prepared.publishedDocument, null);
  const draft = await save('save-home-draft-over-head', prepared.draftDocument, first.revisionId);
  const f = { ...prepared, draft };
  await answer(sample('showcase-editor', 'GET', `${f.path}/showcase-editor${query(owner)}`));
  const before = await publicBundle(f, sessions.visitor, proofRequests(sessions.visitor));
  const configuration = await answer<{ revision: string; configuration: { presentation: ZonePresentation; homeDocument: string } }>(
    sample('draft-configuration', 'GET', `${f.path}/configuration${query(owner)}`));
  expect(first.page).toBe(configuration.configuration.homeDocument);
  expect(f.draft.page).toBe(configuration.configuration.homeDocument);
  expect(configuration.configuration.presentation).toEqual(f.draftPresentation);
  const navigation = await answer<{ revision: string; mounts: Array<{ occurrence: string }> }>(
    sample('draft-navigation', 'GET', `${f.path}${query(owner)}`));
  // Match the editor's page size and both kind-agnostic name reads, including refusals.
  for (const [label, path] of [
    ['draft-navigation-editor', `${f.path}${query(owner)}&limit=50`],
    ['mount-target-collection-name', `/v1/collections/${short(f.collection)}/name`],
    ['mount-target-work', `/v1/works/${short(f.collection)}${query(owner)}`],
  ] as const) {
    const response = await sample(label, 'GET', path);
    const raw = await response.text();
    if (response.status >= 500) throw new Error(`GET ${path}: ${response.status}: ${raw}`);
  }
  expect(navigation.revision).toBe(f.draftNavigation.revision);
  expect(navigation.mounts.map(item => item.occurrence)).toContain(f.draftNavigation.occurrences[0]!);
  const stale = await answer<{ code: string }>(sample('stale-configuration-refused', 'PUT', `${f.path}/configuration`, {
    expectedHead: f.receipt.revision, presentation: f.publishedPresentation, actingSubject: owner.actingSubject,
  }), 409);
  expect(stale.code).toBe('stale_zone_head');
  for (const body of [f.publishBody(f.draft, f.receipt.revision, f.draftNavigation.revision),
    f.publishBody(f.draft, f.configured.revision, f.mounted.revision)]) {
    expect((await answer<{ code: string }>(owner.main('POST', `${f.path}/site-publications`, body), 409)).code)
      .toBe('stale_zone_head');
  }
  expect(await publicBundle(f, sessions.visitor)).toEqual(before);
  const next = await answer<Receipt>(sample('publish-site-bundle', 'POST', `${f.path}/site-publications`,
    f.publishBody(f.draft, f.configured.revision, f.draftNavigation.revision)), 201);
  expect(next).toMatchObject({ routesRevision: f.draftNavigation.revision,
    navigationRevision: f.draftNavigation.revision, themeRevision: f.configured.revision });
  expect(next.homeDocument).toBe(configuration.configuration.homeDocument);
  expect(next.pages).toMatchObject([{ page: f.draft.page, variantId: f.draft.variantId, revisionId: f.draft.revisionId }]);
  const delivered = await answer<Presentation>(proofRequests(sessions.visitor)('republished-presentation', 'GET', `${f.path}/presentation`));
  expect(delivered.presentation).toEqual(f.draftPresentation);
  expect(delivered.navigation.map(item => item.segment)).toEqual(['published-link', 'draft-link']);
  expect(delivered.home?.reference.revisionId).toBe(f.draft.revisionId);
  await answer(sessions.visitor.main('GET', `${f.path}/routes?path=%2Fdraft-link`));
}), recording);

async function supportingReads(sample: ReturnType<typeof recording.session>, f: Awaited<ReturnType<typeof site>>) {
  await answer(sample('space-address', 'GET', `/v1/addresses/resolve?${new URLSearchParams({
    scope: 'space', key: short(f.space),
  })}`));
  await answer(sample('empty-home-presentation', 'GET', `/v1/zones/${short(sessions.zone)}/presentation`));
}

const proofRequests = (person: PersonaSession) => (_label: string, ...args: Parameters<PersonaSession['main']>) => person.main(...args);
const visitRequests: Array<{ persona: PersonaName; label: string; method: string; path: string; body?: unknown; key?: string }> = [];
const requestLabels = new AsyncLocalStorage<(method: string, path: string) => string>();

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
    // The original API proof owns 60 s; recording the production visit owns another 120 s.
    await within(60_000, 'API proof', proof);
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production visit', () => productionVisit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}

async function productionVisit(name: PersonaName) {
  const f = await site();
  const person = sessions[name];
  const zoneId = f.path.split('/').at(-1)!;
  const named = <T,>(label: string | ((method: string, path: string) => string), run: () => Promise<T>) =>
    requestLabels.run(typeof label === 'string' ? () => label : label, run);
  const requests = new Map<string, { call: string; response: Promise<Response> }>();
  let fatal: Error | undefined;
  const client = (caller: PersonaSession) => browserMainApi('https://record.invalid', {
    fetcher: (async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
      const method = init?.method ?? 'GET';
      const label = requestLabels.getStore()?.(method, path);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
      const call = JSON.stringify([method, path, body, key]);
      if (!label || requests.has(label) && requests.get(label)!.call !== call) {
        fatal = new Error(`Production label is ambiguous: ${label}: ${method} ${path}`);
        throw fatal;
      }
      visitRequests.push({ persona: name, label, method, path, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { key }) });
      try {
        const previous = requests.get(label);
        if (previous) {
          // Two mounts of one target send the same name reads in parallel. Keep
          // both sends, but one exact answer for the label the replay selects.
          const response = await caller.main(method, path, body, key);
          const original = await previous.response;
          if (response.status !== original.status || await response.clone().text() !== await original.clone().text())
            throw new Error(`Repeated production request changed its answer: ${label}: ${response.status}: ${await response.clone().text()}`);
          return response;
        }
        const response = recording.session(name, caller)(label, method, path, body, key);
        requests.set(label, { call, response });
        return (await response).clone();
      } catch (error) { fatal = new Error(`${label}: ${method} ${path}: ${String(error)}`); throw fatal; }

    }) as typeof fetch,
  });
  const main = client(person);
  // These public server readers use an anonymous client in production; no other bearer is used.
  const publicMain = name === 'visitor' ? main : client(sessions.visitor);
  const frames = realmFrameReads({ main: publicMain, personal: main, actingSubject: person.actingSubject ?? undefined });
  const publicReads = zonePresentationReads(main, person.actingSubject ?? undefined);
  const siteLabels = (prefix: string) => (_method: string, path: string) => {
    if (path.includes('/addresses/')) return `${prefix}-address`;
    if (path.includes('/realms/')) return `${prefix}-realm-header`;
    return prefix === 'site' ? 'published-presentation' : `${prefix}-presentation`;
  };
  const stop = () => { if (fatal) throw fatal; };
  if (name === 'visitor') {
    const resolved = await named(siteLabels('site'), () => frames.resolveSite(short(f.space), 'en'));
    stop();
    if (resolved.kind !== 'site') return;
    await Promise.all([
      named('published-home', () => publicReads.readZoneRoute(zoneId, '/')),
      named(siteLabels('site'), () => frames.resolveRealm(short(f.space), 'en', 'site')),
    ]);
    await named('published-index-empty', () => publicReads.readZoneRoute(zoneId, '/published-link'));
    await named('unpublished-route-refused', () => publicReads.readZoneRoute(zoneId, '/draft-link'));
    stop();
    return;
  }

  const actingSubject = person.actingSubject!;
  const theme = browserZoneTheme(main);
  const address = await resolveZoneManagementAddress(short(f.space), 'en', {
    configuration: id => named('management-key-configuration', () => settle(() =>
      main.v1.zones({ id }).configuration.get({ query: { actingSubject } }), { management: true })),
    site: (space, locale) => named(siteLabels('management-site'), () => frames.resolveSite(space, locale)),
  });
  stop();
  if (address.kind !== 'site') return;
  // Layout and page share address resolution; their independent reads start in the same render.
  const [editor, zone, lifecycle] = await Promise.all([
    named(name === 'owner' ? 'management-editor' : 'showcase-editor', () => settle(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }), { management: true })),
    named('management-navigation', () => settle(() => main.v1.zones({ id: zoneId }).get({ query: { actingSubject } }), { management: true })),
    named(name === 'owner' ? 'layout-configuration' : 'draft-configuration-refused', () => theme.readConfiguration(zoneId, actingSubject)),
  ]);
  stop();
  if (!editor.ok || !zone.ok || !lifecycle.ok) return;
  const model = authoringModel(editor.data, zone.data, zoneId, short(f.space));
  if (!model) throw new Error('Production authoring model is unavailable');
  const configuration = await named('draft-configuration', () => theme.readConfiguration(zoneId, actingSubject));
  stop();
  if (!configuration.ok) return;
  const patch = zoneThemePatch(configuration.data.configuration, { density: 'comfortable', pageSurface: 'flat' });
  if (!patch) throw new Error('Production theme patch is unavailable');
  await named('stale-configuration-refused', () => theme.saveConfiguration(zoneId, {
    expectedHead: f.receipt.revision, presentation: f.publishedPresentation as Parameters<typeof theme.saveConfiguration>[1]['presentation'], actingSubject,
  }, randomUUID()));
  stop();
  const reviewed = await named('review-theme-configuration', () => theme.readConfiguration(zoneId, actingSubject));
  stop();
  if (!reviewed.ok) return;
  const savedTheme = await named('save-theme', () => theme.saveConfiguration(zoneId, {
    expectedHead: reviewed.data.revision, presentation: patch.presentation, actingSubject,
  }, randomUUID()));
  stop();
  if (!savedTheme.ok) return;
  const navLabels = (_method: string, path: string) => path.includes('/collections/')
    ? 'mount-target-collection-name' : path.includes('/works/') ? 'mount-target-work' : 'draft-navigation-editor';
  const [draft, navigation] = await Promise.all([
    named((_method, path) => path.includes('/showcase-editor') ? 'showcase-editor' : 'draft-navigation',
      () => browserZoneAuthoring(main).readDraft(zoneId, actingSubject)),
    named(navLabels, () => loadZoneNavigation(main, zoneId, actingSubject)),
  ]);
  stop();
  if (!draft.ok || !navigation.ok) return;
  const moved = await named('move-draft-link', () => browserZoneNavigation(main).moveMount(navigation.data.navigation, {
    expectedHead: navigation.data.head, occurrence: f.draftNavigation.occurrences[0]!,
    position: 'first', actingSubject,
  }, randomUUID()));
  stop();
  if (!moved.ok) return;
  await named('saved-preview', () => settle(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }), { management: true }));
  const resolved = await named(siteLabels('republished'), () => frames.resolveRealm(short(f.space), 'en', 'site'));
  stop();
  if (resolved.kind !== 'realm') return;
  await Promise.all([
    named('republished-presentation', () => publicReads.readCompletePresentation(zoneId)),
    named((_method, path) => path.includes('/joining') ? 'site-membership' : 'site-follow',
      () => readMembership(main, resolved.header.id, actingSubject)),
  ]);
  stop();
}
