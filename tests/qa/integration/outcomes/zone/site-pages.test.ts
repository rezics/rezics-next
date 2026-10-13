import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import row from '../../../../../scripts/qa/cases/outcomes/zone/site-pages.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Page = { page: string; variantId: string; revisionId: string; byteDigest: string; contentEpoch: string };
type Reference = { resourceId: string; revisionId: string; provenance: { rightsBasis: string; author: string } };
type Home = { realm: string | null; page?: { reference: Reference; document: DocumentSnapshot } };
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
  return { path, homeDocument, page, draft, publishedDocument, draftDocument, draftBody, publishBody, body, key, receipt };
}

async function reads(name: PersonaName) {
  const f = await site();
  const person = sessions[name];
  const home = await answer<Home>(person.main('GET', `${f.path}/routes?path=%2F`));
  expect(home.realm).toBeNull();
  expect(home.page).toMatchObject({ reference: { resourceId: f.homeDocument, revisionId: f.page.revisionId,
    provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject } },
    document: f.publishedDocument });
  const exact = await answer<{ reference: Reference; body: { document: DocumentSnapshot }; serializedJson: string }>(
    person.main('GET', `/v1/content-revisions/${f.page.revisionId}${query(person)}`));
  expect(exact.reference).toEqual(home.page!.reference);
  expect(exact.body.document).toEqual(f.publishedDocument);
  expect(JSON.parse(exact.serializedJson).document).toEqual(f.publishedDocument);
  await answer(person.main('GET', `/v1/content-revisions/${f.draft.revisionId}${query(person)}`), 404);
  if (name !== 'visitor') {
    await answer(person.main('POST', '/v1/content-drafts', {
      ...f.draftBody(fromPlainText('Unauthorized replacement', 'blocks'), f.draft.revisionId),
      actingSubject: person.actingSubject,
    }), 403);
    await answer(person.main('GET', `${f.path}/configuration${query(person)}`), 404);
  }
  expect((await answer<Home>(sessions.visitor.main('GET', `${f.path}/routes?path=%2F`))).page).toEqual(home.page);
}

outcomeTest(row, 'visitor', () => reads('visitor'));
outcomeTest(row, 'stranger', () => reads('stranger'));
outcomeTest(row, 'member', () => reads('member'));
outcomeTest(row, 'moderator', () => reads('moderator'));
outcomeTest(row, 'operator', () => reads('operator'));
outcomeTest(row, 'owner', async () => {
  const f = await site();
  const exact = await answer<{ body: { document: DocumentSnapshot } }>(
    sessions.owner.main('GET', `/v1/content-revisions/${f.draft.revisionId}${query(sessions.owner)}`));
  expect(exact.body.document).toEqual(f.draftDocument);
  const home = () => answer<Home>(sessions.visitor.main('GET', `${f.path}/routes?path=%2F`));
  expect((await home()).page?.document).toEqual(f.publishedDocument);
  const next = await answer<Receipt>(sessions.owner.main('POST', `${f.path}/site-publications`,
    f.publishBody(f.draft, f.receipt.revision)), 201);
  expect(next.pages).toEqual(expect.arrayContaining([
    expect.objectContaining({ page: f.homeDocument, revisionId: f.draft.revisionId, variantId: f.draft.variantId }),
  ]));
  expect((await home()).page).toMatchObject({ document: f.draftDocument, reference: {
    revisionId: f.draft.revisionId, provenance: { rightsBasis: 'original-contribution', author: sessions.owner.actingSubject },
  } });
  await answer(sessions.visitor.main('GET', `/v1/content-revisions/${f.page.revisionId}`), 404);
});

