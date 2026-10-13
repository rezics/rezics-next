import { afterAll, beforeAll, expect, onTestFinished, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import row from '../../../../../scripts/qa/cases/outcomes/zone/site-pages.ts';
import { outcomeTitle } from '../../../../../scripts/qa/cases/outcome-cells.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
type Reference = { resourceId: string; revisionId: string; provenance: { rightsBasis: string; author: string } };
type Home = { realm: string | null; page?: { reference: Reference; document: DocumentSnapshot } };
type Receipt = { receipt: string; revision: string; homeDocument: string; homeRevision: string;
  routesRevision: string; navigationRevision: string; themeRevision: string;
  pages: Array<Pick<Page, 'page' | 'variantId' | 'revisionId'>>; replayed: boolean };
// Freeze the declared public promise: reducing an implementation limit must not turn this proof green.
const publicationPageBound = 32;
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
    expectedHead: created.zoneRevision, prepareHomeDocument: true, actingSubject: owner.actingSubject,
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
  const publishedDocument = fromPlainText('Published owner text', 'blocks');
  const page = await save(publishedDocument, null);
  const publishBody = (selected: Page, expectedHead: string) => ({
    expectedHead, actingSubject: owner.actingSubject, routesRevision: created.navigationRevision,
    navigationRevision: created.navigationRevision, pages: [selected],
  });
  const body = publishBody(page, prepared.revision);
  const key = randomUUID();
  const receipt = await answer<Receipt>(owner.main('POST', `${path}/site-publications`, body, key), 201);
  const draftDocument = fromPlainText('Private subsequent owner text', 'blocks');
  const draft = await save(draftDocument, page.revisionId);
  return { space: created.space, path, homeDocument, page, draft, publishedDocument, draftDocument, draftBody, publishBody, body, key, receipt };
}

async function reads(name: PersonaName) {
  const f = await site();
  const person = sessions[name];
  const sample = recording.session(name, person);
  if (name === 'visitor') await supportingReads(sample, f);
  const home = await answer<Home>(sample('published-home-route', 'GET', `${f.path}/routes?path=%2F`));
  expect(home.realm).toBeNull();
  expect(home.page).toMatchObject({ reference: { resourceId: f.homeDocument, revisionId: f.page.revisionId,
    provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject } },
    document: f.publishedDocument });
  const exact = await answer<{ reference: Reference; body: { document: DocumentSnapshot }; serializedJson: string }>(
    sample('published-content-revision', 'GET', `/v1/content-revisions/${f.page.revisionId}${query(person)}`));
  expect(exact.reference).toEqual(home.page!.reference);
  expect(exact.body.document).toEqual(f.publishedDocument);
  expect(JSON.parse(exact.serializedJson).document).toEqual(f.publishedDocument);
  await answer(sample('draft-content-revision', 'GET', `/v1/content-revisions/${f.draft.revisionId}${query(person)}`), 404);
  if (name !== 'visitor') {
    await answer(person.main('POST', '/v1/content-drafts', {
      ...f.draftBody(fromPlainText('Unauthorized replacement', 'blocks'), f.draft.revisionId),
      actingSubject: person.actingSubject,
    }), 403);
    await answer(sample('draft-configuration-refused', 'GET', `${f.path}/configuration${query(person)}`), 404);
    await answer(sample('showcase-editor-refused', 'GET', `${f.path}/showcase-editor${query(person)}`), 404);
  }
  expect((await answer<Home>(sessions.visitor.main('GET', `${f.path}/routes?path=%2F`))).page).toEqual(home.page);
}

outcomeTest(row, 'visitor', () => reads('visitor'), recording);
outcomeTest(row, 'stranger', () => reads('stranger'), recording);
outcomeTest(row, 'member', () => reads('member'), recording);
outcomeTest(row, 'moderator', () => reads('moderator'), recording);
outcomeTest(row, 'operator', () => reads('operator'), recording);
// The pending declaration retains a required red proof rather than accepting its refusal.
test(outcomeTitle(row, 'owner'), () => {
  onTestFinished(() => recording.finish('owner'));
  return recording.prove('owner', proveOwner);
});

async function proveOwner() {
  const f = await site();
  const sample = recording.session('owner', sessions.owner);
  await answer(sample('showcase-editor', 'GET', `${f.path}/showcase-editor${query(sessions.owner)}`));
  const exact = await answer<{ body: { document: DocumentSnapshot } }>(
    sample('draft-content-revision', 'GET', `/v1/content-revisions/${f.draft.revisionId}${query(sessions.owner)}`));
  expect(exact.body.document).toEqual(f.draftDocument);
  const home = () => answer<Home>(sessions.visitor.main('GET', `${f.path}/routes?path=%2F`));
  expect((await home()).page?.document).toEqual(f.publishedDocument);
  const next = await answer<Receipt>(sample('publish-home-revision', 'POST', `${f.path}/site-publications`,
    f.publishBody(f.draft, f.receipt.revision)), 201);
  expect(next.pages).toEqual(expect.arrayContaining([
    expect.objectContaining({ page: f.homeDocument, revisionId: f.draft.revisionId, variantId: f.draft.variantId }),
  ]));
  expect((await home()).page).toMatchObject({ document: f.draftDocument, reference: {
    revisionId: f.draft.revisionId, provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject },
  } });
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${f.page.revisionId}`), 404);
  const replay = await answer<Receipt>(sample('replay-original-publication', 'POST', `${f.path}/site-publications`,
    f.body, f.key));
  expect(replay).toEqual({ ...f.receipt, replayed: true });
  await answer(sample('stale-publication-refused', 'POST', `${f.path}/site-publications`, f.body), 409);
  expect((await home()).page?.document).toEqual(f.draftDocument);
  await publishBoundedPages(sample, f, next.revision);
}

async function publishBoundedPages(sample: ReturnType<typeof recording.session>,
  f: Awaited<ReturnType<typeof site>>, expectedHead: string) {
  const preparationStarted = performance.now();
  const pages: Page[] = [];
  const drafts = [];
  // Distinct variants have independent draft heads; bounded concurrency fits the existing proof wall.
  for (let index = 0; index < publicationPageBound; index += 4) {
    const prepared = await Promise.all(Array.from({
      length: Math.min(4, publicationPageBound - index),
    }, (_, offset) => saveBoundedPage(sample, f, index + offset)));
    pages.push(...prepared.map(item => item.page));
    drafts.push(...prepared.map(item => item.draft));
  }
  expect(pages).toHaveLength(publicationPageBound);
  expect(new Set(pages.map(page => page.revisionId)).size).toBe(pages.length);
  const preparationMs = performance.now() - preparationStarted;
  const body = { ...f.body, expectedHead, pages };
  const key = randomUUID();
  const path = `${f.path}/site-publications`;
  const response = await sample('publish-full-bounded-page-set', 'POST', path, body, key);
  const responseBody: unknown = await response.clone().json();
  await Bun.write(`.temp/site-pages-owner-bound-${Bun.env.REZICS_QA_RUN_ID}.json`, JSON.stringify({
    runId: Bun.env.REZICS_QA_RUN_ID, row: row.rowId, persona: 'owner',
    declaredMaxPages: publicationPageBound, preparationMs,
    homeDocument: f.homeDocument, drafts, selections: pages,
    request: { method: 'POST', path, idempotencyKey: key, body },
    response: { status: response.status, body: responseBody },
  }, null, 2));
  const published = await answer<Receipt>(Promise.resolve(response), 201);
  expect(published.pages).toHaveLength(pages.length);
  const selected = (page: Pick<Page, 'page' | 'variantId' | 'revisionId'>) => ({
    page: page.page, variantId: page.variantId, revisionId: page.revisionId,
  });
  expect(published.pages.map(selected)).toEqual(expect.arrayContaining(pages.map(selected)));
}

async function saveBoundedPage(sample: ReturnType<typeof recording.session>,
  f: Awaited<ReturnType<typeof site>>, index: number) {
  const body = { ...f.draftBody(fromPlainText(`Bounded owner page ${index + 1}`, 'blocks'), null),
    variantId: `urn:rezics:variant:${randomUUID()}` };
  const key = randomUUID();
  const saved = await answer<{ revisionId: string; byteDigest: string;
    sourcePosition: { dataEpoch: string; sequence: string } }>(
    sample(`save-bounded-page-${index + 1}`, 'POST', '/v1/content-drafts', body, key), 201);
  const page = { page: f.homeDocument, variantId: body.variantId, revisionId: saved.revisionId,
    byteDigest: saved.byteDigest, contentEpoch: saved.sourcePosition.dataEpoch };
  expect(page.byteDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(page.contentEpoch).toMatch(/^[0-9a-f-]{36}$/);
  return { page, draft: {
    request: { method: 'POST', path: '/v1/content-drafts', idempotencyKey: key, body },
    response: { status: 201, body: saved },
  } };
}

async function supportingReads(sample: ReturnType<typeof recording.session>, f: Awaited<ReturnType<typeof site>>) {
  await answer(sample('space-address', 'GET', `/v1/addresses/resolve?${new URLSearchParams({
    scope: 'space', key: short(f.space),
  })}`));
  await answer(sample('empty-home-presentation', 'GET', `/v1/zones/${short(sessions.zone)}/presentation`));
  await answer(sample('published-presentation', 'GET', `${f.path}/presentation`));
  await answer(sample('missing-route-refused', 'GET', `${f.path}/routes?path=%2Fmissing`), 404);
}
