import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { platformOperationOpen, type PlatformAccessSummary } from '../../../../../generated/openapi/main/exposure.ts';
import row from '../../../../../scripts/qa/cases/outcomes/zone/home-rendering.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type ZonePresentation = { tokens: Record<string, string>;
  slides: Array<{ id: string; href: string; title: string }>; [field: string]: unknown };
type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
type Reference = { resourceId: string; revisionId: string; provenance: { rightsBasis: string; author: string } };
type Home = { realm: string | null; page?: { reference: Reference; document: DocumentSnapshot; blocks: Array<Record<string, unknown>>;
  showcases: Array<Record<string, unknown>>; showcaseData: { slides: ZonePresentation['slides'] } } };
type Presentation = { revision: string; presentation: ZonePresentation; renderTokens: ZonePresentation['tokens'];
  navigation: Array<{ occurrence: string; segment: string }>; home?: Home['page'] };
type Receipt = { receipt: string; revision: string; homeDocument: string; homeRevision: string;
  routesRevision: string; navigationRevision: string; themeRevision: string;
  pages: Array<Pick<Page, 'page' | 'variantId' | 'revisionId'>>; replayed: boolean };
setDefaultTimeout(60_000);
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
  try { await recording.publish(); }
  finally { await sessions?.close(); }
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
  const empty = await answer<{ address: { key: string } }>(
    sessions.visitor.main('GET', `/v1/zones/${short(sessions.zone)}/presentation`));
  return { space: created.space, path, homeDocument, page, draft, publishedDocument, draftDocument, draftBody, publishBody, body, key, receipt,
    collection, mounted, draftNavigation, publishedPresentation, draftPresentation, configured, unknownPayload, emptyAddress: empty.address.key };
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

async function render(name: PersonaName) {
  const f = await site();
  const person = sessions[name];
  const sample = recording.session(name, person);
  await frameReads(name, person, f);
  if (name === 'visitor') await supportingReads(sample, f);
  await publicBundle(f, person, sample);
  const home = await answer<Home>(sample('published-home-route', 'GET', `${f.path}/routes?path=%2F`));
  expect(home.realm).toBe(sessions.realm);
  expect(home.page?.document).toEqual(f.publishedDocument);
  expect(home.page?.reference).toMatchObject({ resourceId: f.homeDocument, revisionId: f.page.revisionId,
    provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject } });
  expect(home.page?.blocks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'showcase', status: 'resolved', kind: 'showcase' }),
    expect.objectContaining({ id: 'unknown-map', status: 'placeholder', reason: 'unknown_definition', fallback: 'Place map' }),
  ]));
  expect(home.page?.showcases).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: '$default', module: null, sources: [] }),
  ]));
  expect(home.page?.showcaseData.slides).toEqual(f.publishedPresentation.slides);
  const exact = await answer<{ reference: Reference; body: { document: DocumentSnapshot }; serializedJson: string }>(
    sample('published-content-revision', 'GET', `/v1/content-revisions/${f.page.revisionId}${query(person)}`));
  expect(exact.reference).toEqual(home.page!.reference);
  expect(exact.body.document).toEqual(f.publishedDocument);
  expect(JSON.parse(exact.serializedJson).document.doc.content.at(-1).attrs.payload).toEqual(f.unknownPayload);
  if (name === 'owner') {
    const draft = await answer<{ body: { document: DocumentSnapshot } }>(
      sample('draft-content-revision', 'GET', `/v1/content-revisions/${f.draft.revisionId}${query(person)}`));
    expect(draft.body.document).toEqual(f.draftDocument);
    const editor = await answer<{ draft: { revisionId: string; document: DocumentSnapshot };
      preview: { presentation: ZonePresentation; publicationStatus: string }; publishedPage: { revisionId: string } }>(
      sample('showcase-editor', 'GET', `${f.path}/showcase-editor${query(person)}`));
    expect(editor.draft).toMatchObject({ revisionId: f.draft.revisionId, document: f.draftDocument });
    expect(editor.preview.presentation).toEqual(f.draftPresentation);
    expect(editor.preview.publicationStatus).toBe('behind');
    expect(editor.publishedPage.revisionId).toBe(f.page.revisionId);
    expect((await answer<Home>(sessions.visitor.main('GET', `${f.path}/routes?path=%2F`))).page).toEqual(home.page);
  } else {
    await answer(sample('draft-content-revision', 'GET', `/v1/content-revisions/${f.draft.revisionId}${query(person)}`), 404);
    if (name !== 'visitor') {
      await answer(sample('showcase-editor', 'GET', `${f.path}/showcase-editor${query(person)}`), 404);
      await answer(sample('draft-configuration-refused', 'GET', `${f.path}/configuration${query(person)}`), 404);
    }
    await privateNavigation(f, person);
  }
}

async function frameReads(name: PersonaName, person: PersonaSession, f: Awaited<ReturnType<typeof site>>) {
  // The frame's public client stays anonymous even in a signed-in proof.
  const anonymous = recording.session(name, sessions.visitor);
  const personal = recording.session(name, person);
  const language = { headers: { 'accept-language': 'en', 'x-rezics-display-languages': 'en' } };
  const realm = short(sessions.realm);
  for (const home of [
    { label: 'published', path: f.path, address: short(f.space) },
    { label: 'empty', path: `/v1/zones/${short(sessions.zone)}`, address: f.emptyAddress },
  ]) {
    const prefix = `frame-${home.label}`;
    await answer(anonymous(`${prefix}-space-address`, 'GET', `/v1/addresses/resolve?${new URLSearchParams({
      scope: 'space', key: home.address,
    })}`, undefined, undefined, language));
    await answer(anonymous(`${prefix}-realm-header`, 'GET', `/v1/realms/${realm}`, undefined, undefined, language));
    await answer(anonymous(`${prefix}-facets`, 'GET', '/v1/facets', undefined, undefined, language));
    if (person.actingSubject) {
      // PersonaSession supplies its opaque x-session-key alongside its bearer.
      await answer(personal(`${prefix}-session-agent`, 'GET', '/v1/me/session-agent', undefined, undefined, language));
      await answer(personal(`${prefix}-person-preferences`, 'GET', `/v1/me/person-preferences${query(person)}`));
      await answer(personal(`${prefix}-joining`, 'GET', `/v1/realms/${realm}/joining${query(person)}`, undefined, undefined, language));
      await answer(personal(`${prefix}-follow`, 'GET', `/v1/follows/${realm}?${new URLSearchParams({
        kind: 'realm', actingSubject: person.actingSubject,
      })}`, undefined, undefined, language));
      const access = await answer<PlatformAccessSummary>(personal(`${prefix}-platform-access`, 'GET', '/v1/me/platform-access'));
      if (platformOperationOpen('getV1RealmsByRealmMember-ban', access)) {
        await answer(personal(`${prefix}-own-ban`, 'GET', `/v1/realms/${realm}/member-ban${query(person)}`));
      }
    }
    await answer(personal(`${prefix}-presentation`, 'GET', `${home.path}/presentation${query(person)}`, undefined, undefined, language));
    await answer(personal(`${prefix}-home-route`, 'GET', `${home.path}/routes?${new URLSearchParams({
      ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}), path: '/',
    })}`, undefined, undefined, language));
    if (home.label === 'empty') {
      await answer(anonymous(`${prefix}-browse-counts`, 'GET', `/v1/realms/${realm}/modules/browse?limit=1`, undefined, undefined, language));
    }
  }
}

outcomeTest(row, 'visitor', () => render('visitor'), recording);
outcomeTest(row, 'stranger', () => render('stranger'), recording);
outcomeTest(row, 'member', () => render('member'), recording);
outcomeTest(row, 'moderator', () => render('moderator'), recording);
outcomeTest(row, 'operator', () => render('operator'), recording);
outcomeTest(row, 'owner', () => render('owner'), recording);

async function supportingReads(sample: ReturnType<typeof recording.session>, f: Awaited<ReturnType<typeof site>>) {
  await answer(sample('space-address', 'GET', `/v1/addresses/resolve?${new URLSearchParams({
    scope: 'space', key: short(f.space),
  })}`));
  await answer(sample('empty-home-presentation', 'GET', `/v1/zones/${short(sessions.zone)}/presentation`));
}
