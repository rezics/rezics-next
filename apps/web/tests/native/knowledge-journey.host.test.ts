import { afterAll, setDefaultTimeout } from 'bun:test';
import type { Page } from 'playwright';
import { knowledgeMediaSource, parseKnowledgeMediaSource } from '@rezics/definitions/knowledge-media';
import { lanternFerryCoverPng } from './hosted-book-journey-fixture';
import { expect } from 'playwright/test';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import {
  isKnowledgeJourneyId,
  knowledgeJourneyClick,
  knowledgeJourneyCopy,
  knowledgeJourneyText as text,
  startKnowledgeJourneyFixture,
  type KnowledgeJourneyDocument,
  type KnowledgeJourneyFixture,
} from './knowledge-journey-fixture.ts';

setDefaultTimeout(600_000);

const lifecycle = new NativeTestLifecycle('native knowledge journey suite');
const copy = knowledgeJourneyCopy();
let fixture: KnowledgeJourneyFixture;

nativeBeforeAll(lifecycle, 360_000, async () => {
  fixture = await startKnowledgeJourneyFixture();
});

afterAll(async () => {
  await fixture?.close();
}, 240_000);
nativeAfterAll(lifecycle, 240_000);

async function authorPage(): Promise<Page> {
  const journey = await fixture.auth.signIn('alice', { returnTo: fixture.createHref });
  const page = await journey.context.newPage();
  page.setDefaultTimeout(60_000);
  return page;
}

async function expectAbsent(page: Page, ...values: string[]): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const value of values) expect(body, `page leaked ${value}`).not.toContain(value);
}

async function expectPrivateTextsAbsent(page: Page, extra: string[] = []): Promise<void> {
  await expectAbsent(page, text.parentBody, text.firstBody, text.laterBody, text.reuseSeedBody, ...extra);
}

function asDocument(value: KnowledgeJourneyDocument | { status: number; body: string }): KnowledgeJourneyDocument {
  if ('status' in value) throw new Error(`expected a private document, received HTTP ${value.status}: ${value.body}`);
  return value;
}

const imageAlt = 'Original Knowledge scene study';

async function uploadKnowledgeImageInEditor(page: Page, documentId: string): Promise<string> {
  const reserved = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await page
    .getByLabel('Choose image file', { exact: true })
    .setInputFiles({ name: 'knowledge-scene-study.png', mimeType: 'image/png', buffer: lanternFerryCoverPng() });
  await page.getByLabel('Alt text', { exact: true }).fill(imageAlt);
  await page.getByRole('button', { name: 'Insert image', exact: true }).click();
  const response = await reserved;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ purpose: 'knowledge-image', containerId: documentId });
  const body = (await response.json()) as { media?: { id?: string } };
  if (!isKnowledgeJourneyId(body.media?.id)) throw new Error('Knowledge image reservation omitted its native media ID');
  const image = page.locator('.ProseMirror').getByRole('img', { name: imageAlt, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0),
    )
    .toBe(true);
  return body.media!.id!;
}

nativeTest(
  'an author publishes one exact nested revision, public reading stays frozen, and reuse copies that revision into a second notebook',
  600_000,
  async () => {
    const page = await authorPage();
    const alice = fixture.alice.accountId;
    const bob = fixture.bob.accountId;
    const subjectId = fixture.subject.id;
    expect(isKnowledgeJourneyId(subjectId)).toBe(true);

    fixture.evidence.stage = 'private-save';
    await fixture.open(page, fixture.createHref);
    await expect(page.getByLabel(copy.notebookTitle, { exact: true })).toBeVisible();
    await fixture.fillTitle(page, copy.notebookTitle, text.notebook);
    await knowledgeJourneyClick(page, copy.createNotebook);
    await fixture.waitStatus(page, copy.notebookAcknowledged);
    const sourceNotebookId = await fixture.labeledValue(page, copy.notebookId);
    expect(isKnowledgeJourneyId(sourceNotebookId)).toBe(true);
    fixture.evidence.sourceNotebookId = sourceNotebookId;
    const notebooks = await fixture.readOwnedNotebooks('private-save', 'alice', alice);
    expect(notebooks.some((row) => row.notebookId === sourceNotebookId && row.title === text.notebook)).toBe(true);

    await fixture.fillTitle(page, copy.documentTitle, text.parentTitle);
    await fixture.fillBody(page, text.parentBody);
    await fixture.waitEnabled(page, copy.createDocument);
    await knowledgeJourneyClick(page, copy.createDocument);
    await expect(page.getByText(copy.documentAcknowledged).or(page.getByText(copy.currentHead))).toBeVisible();
    const root = await fixture.readOutline('private-save', 'alice', alice, sourceNotebookId, null);
    const parentRow = root.placements.find((row) => row.title === text.parentTitle);
    if (!parentRow) throw new Error(`private-save root outline omitted ${text.parentTitle}: ${JSON.stringify(root)}`);
    const parent = await fixture.requirePrivateDocument(
      'private-save',
      'alice',
      alice,
      sourceNotebookId,
      parentRow.documentId,
    );
    parent.placementId = parentRow.placementId;
    expect(parent.title).toBe(text.parentTitle);
    expect(parent.body).toBe(text.parentBody);
    expect(parent.publicationId).toBeNull();
    fixture.evidence.parent = parent;

    await fixture.open(page, fixture.createHref);
    await knowledgeJourneyClick(page, copy.existingNotebook);
    await knowledgeJourneyClick(page, copy.openNotebooks);
    await expect(page.getByText(text.notebook)).toBeVisible();
    await expect(page.getByText(sourceNotebookId)).toBeVisible();
    await page
      .locator('li')
      .filter({ hasText: text.notebook })
      .getByRole('button', { name: copy.useNotebook, exact: true })
      .click();
    await knowledgeJourneyClick(page, copy.openOutline);
    await expect(page.getByText(text.parentTitle)).toBeVisible();
    await page
      .locator('li')
      .filter({ hasText: text.parentTitle })
      .getByRole('button', { name: copy.openParent, exact: true })
      .click();
    await knowledgeJourneyClick(page, copy.placeHere);
    await expect(page.getByText(text.parentTitle)).toBeVisible();
    await fixture.fillTitle(page, copy.documentTitle, text.firstTitle);
    await fixture.fillBody(page, text.firstBody);
    await fixture.waitEnabled(page, copy.createDocument);
    await knowledgeJourneyClick(page, copy.createDocument);
    await expect(page.getByText(copy.documentAcknowledged).or(page.getByText(copy.currentHead))).toBeVisible();
    const nested = await fixture.readOutline('private-save', 'alice', alice, sourceNotebookId, parent.placementId);
    const childRow = nested.placements.find((row) => row.title === text.firstTitle);
    if (!childRow) throw new Error(`private-save nested outline omitted ${text.firstTitle}: ${JSON.stringify(nested)}`);
    const firstHead = await fixture.requirePrivateDocument(
      'private-save',
      'alice',
      alice,
      sourceNotebookId,
      childRow.documentId,
    );
    firstHead.placementId = childRow.placementId;
    expect(firstHead.title).toBe(text.firstTitle);
    expect(firstHead.body).toBe(text.firstBody);
    expect(firstHead.publicationId).toBeNull();
    fixture.evidence.child = firstHead;
    fixture.evidence.firstRevisionId = firstHead.revisionId;

    await fixture.open(page, fixture.privateHref(sourceNotebookId, firstHead.documentId));
    await expect(page.getByText(copy.currentHead)).toBeVisible();
    await expect(page.locator('.ProseMirror')).toContainText(text.firstBody);
    await fixture.fillTitle(page, copy.documentTitle, text.selectedTitle);
    await fixture.fillBody(page, text.selectedBody);
    const mediaId = await uploadKnowledgeImageInEditor(page, firstHead.documentId);
    fixture.evidence.mediaId = mediaId;
    await fixture.waitEnabled(page, copy.save);
    await knowledgeJourneyClick(page, copy.save);
    await fixture.waitStatus(page, copy.readbackConfirmed);
    const selectedHead = await fixture.requirePrivateDocument(
      'private-save',
      'alice',
      alice,
      sourceNotebookId,
      firstHead.documentId,
    );
    selectedHead.placementId = firstHead.placementId;
    expect(selectedHead.title).toBe(text.selectedTitle);
    expect(selectedHead.body.trim()).toBe([text.selectedBody, imageAlt].join('\n'));
    const selectedBody = selectedHead.body;
    expect(selectedHead.mediaSources).toEqual([knowledgeMediaSource(mediaId)]);
    expect(selectedHead.revisionId).not.toBe(firstHead.revisionId);
    expect(selectedHead.publicationId).toBeNull();
    fixture.evidence.child = selectedHead;
    fixture.evidence.selectedRevisionId = selectedHead.revisionId;
    const savedHistory = await fixture.readHistory(
      'private-save',
      'alice',
      alice,
      sourceNotebookId,
      firstHead.documentId,
    );
    expect(savedHistory.map((row) => row.revisionId).sort()).toEqual(
      [firstHead.revisionId, selectedHead.revisionId].sort(),
    );

    fixture.evidence.stage = 'publication';
    await knowledgeJourneyClick(page, copy.reviewPublication);
    await expect(page.getByText(text.selectedTitle)).toBeVisible();
    const publicationReview = page.getByRole('region', { name: copy.reviewPublication, exact: true });
    await expect(publicationReview.getByText(text.selectedBody, { exact: true })).toBeVisible();
    const previewImage = publicationReview.getByRole('img', { name: imageAlt, exact: true });
    await expect(previewImage).toBeVisible();
    await expect
      .poll(() =>
        previewImage.evaluate(
          (element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await expect(publicationReview.getByText(selectedHead.revisionId, { exact: true })).toBeVisible();
    await expectAbsent(page, text.parentBody, text.firstBody, text.laterBody);
    await knowledgeJourneyClick(page, copy.publishExact);
    await fixture.waitStatus(page, copy.publicationAcknowledged);
    await fixture.waitStatus(page, copy.publicationObserved);
    const publishedPrivate = await fixture.requirePrivateDocument(
      'publication',
      'alice',
      alice,
      sourceNotebookId,
      firstHead.documentId,
    );
    expect(publishedPrivate.revisionId).toBe(selectedHead.revisionId);
    const publicationId = publishedPrivate.publicationId;
    if (!isKnowledgeJourneyId(publicationId))
      throw new Error(`publication private read omitted publication identity: ${JSON.stringify(publishedPrivate)}`);
    expect(publishedPrivate.body).toBe(selectedBody);
    fixture.evidence.selectedPublicationId = publicationId;
    await expect(page.getByText(publicationId)).toBeVisible();
    const nativePublication = await fixture.requirePublicDocument(
      'publication',
      firstHead.documentId,
      selectedHead.revisionId,
    );
    expect(nativePublication).toMatchObject({
      documentId: firstHead.documentId,
      revisionId: selectedHead.revisionId,
      publicationId,
      subjectId,
      title: text.selectedTitle,
      body: selectedBody,
      authorId: null,
    });

    expect(nativePublication.sourceSha256).toBe(selectedHead.sha256);
    const publicImageSource = parseKnowledgeMediaSource(nativePublication.mediaSources[0]);
    expect(publicImageSource).toEqual({
      mediaId,
      selection: {
        representation: 'public',
        documentId: firstHead.documentId,
        revisionId: selectedHead.revisionId,
        sourceSha256: selectedHead.sha256,
        publicationId,
      },
    });

    fixture.evidence.stage = 'public-read';
    const anonymous = await fixture.auth.newContext('anonymous');
    const publicPage = await anonymous.newPage();
    publicPage.setDefaultTimeout(60_000);
    await fixture.open(publicPage, fixture.liveHref(firstHead.documentId));
    await expect(publicPage.getByText(copy.liveKind)).toBeVisible();
    await expect(publicPage.getByRole('heading', { name: text.selectedTitle })).toBeVisible();
    await expect(publicPage.getByRole('main')).toContainText(text.selectedBody);
    const publicImage = publicPage.getByRole('img', { name: imageAlt, exact: true });
    await expect(publicImage).toBeVisible();
    await expect
      .poll(() =>
        publicImage.evaluate(
          (element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const publicImageUrl = new URL((await publicImage.getAttribute('src'))!, publicPage.url()).href;
    const mediaContext = new URL(publicImageUrl).searchParams;
    expect(mediaContext.get('knowledgeDocumentId')).toBe(firstHead.documentId);
    expect(mediaContext.get('knowledgeRevisionId')).toBe(selectedHead.revisionId);
    expect(mediaContext.get('knowledgeSourceSha256')).toBe(selectedHead.sha256);
    expect(mediaContext.get('knowledgePublicationId')).toBe(publicationId);
    expect((await anonymous.request.get(publicImageUrl)).status()).toBe(200);
    await expectPrivateTextsAbsent(publicPage, [text.firstTitle, text.parentTitle, text.laterTitle]);
    await fixture.open(publicPage, fixture.exactHref(firstHead.documentId, selectedHead.revisionId));
    await expect(publicPage.getByText(copy.exactKind)).toBeVisible();
    await expect(publicPage.getByRole('main')).toContainText(text.selectedBody);
    await expectPrivateTextsAbsent(publicPage, [text.firstTitle, text.laterTitle]);

    const anonymousLive = await fixture.requirePublicDocument('public-read', firstHead.documentId);
    expect(anonymousLive.revisionId).toBe(selectedHead.revisionId);
    expect(anonymousLive.publicationId).toBe(publicationId);
    expect(anonymousLive.body).toBe(selectedBody);
    expect(anonymousLive.authorId).toBeNull();
    const firstPublic = await fixture.readPublicDocument(
      'public-read',
      firstHead.documentId,
      firstHead.revisionId,
      undefined,
      404,
    );
    expect('status' in firstPublic && firstPublic.status).toBe(404);
    const parentPublic = await fixture.readPublicDocument('public-read', parent.documentId, undefined, undefined, 404);
    expect('status' in parentPublic && parentPublic.status).toBe(404);
    await fixture.requireUnauthorizedPrivate(
      'public-read',
      'anonymous private child',
      undefined,
      alice,
      sourceNotebookId,
      firstHead.documentId,
      [401, 403, 404],
    );
    await fixture.requireUnauthorizedPrivate(
      'public-read',
      'bob private child',
      'bob',
      alice,
      sourceNotebookId,
      firstHead.documentId,
      [404],
    );
    await fixture.requireUnauthorizedPrivate(
      'public-read',
      'bob private parent',
      'bob',
      alice,
      sourceNotebookId,
      parent.documentId,
      [404],
    );
    const bobJourney = await fixture.auth.signIn('bob');
    const bobPage = await bobJourney.context.newPage();
    bobPage.setDefaultTimeout(60_000);
    await fixture.open(bobPage, fixture.privateHref(sourceNotebookId, firstHead.documentId));
    await expect(bobPage.getByText(copy.privateDenied).or(bobPage.getByText(copy.privateNotFound))).toBeVisible();
    await expectPrivateTextsAbsent(bobPage, [text.selectedBody, text.selectedTitle]);
    await fixture.open(bobPage, fixture.liveHref(firstHead.documentId));
    await expect(bobPage.getByRole('main')).toContainText(text.selectedBody);
    await expectAbsent(bobPage, text.parentBody, text.firstBody, text.laterBody);

    await fixture.open(page, fixture.privateHref(sourceNotebookId, firstHead.documentId));
    await expect(page.getByText(copy.currentHead)).toBeVisible();
    await fixture.fillTitle(page, copy.documentTitle, text.laterTitle);
    await fixture.fillBody(page, text.laterBody);
    await fixture.waitEnabled(page, copy.save);
    await knowledgeJourneyClick(page, copy.save);
    await fixture.waitStatus(page, copy.readbackConfirmed);
    await expect(page.getByText(copy.newerDraft)).toBeVisible();
    const laterHead = await fixture.requirePrivateDocument(
      'public-read',
      'alice',
      alice,
      sourceNotebookId,
      firstHead.documentId,
    );
    expect(laterHead.title).toBe(text.laterTitle);
    expect(laterHead.body).toBe(text.laterBody);
    expect(laterHead.revisionId).not.toBe(selectedHead.revisionId);
    expect(laterHead.publicationId).toBe(publicationId);
    fixture.evidence.laterRevisionId = laterHead.revisionId;
    const frozenPublic = await fixture.requirePublicDocument('public-read', firstHead.documentId);
    expect(frozenPublic.revisionId).toBe(selectedHead.revisionId);
    expect(frozenPublic.body).toBe(text.selectedBody);
    expect(frozenPublic.publicationId).toBe(publicationId);
    const laterPublic = await fixture.readPublicDocument(
      'public-read',
      firstHead.documentId,
      laterHead.revisionId,
      undefined,
      404,
    );
    expect('status' in laterPublic && laterPublic.status).toBe(404);
    await fixture.open(publicPage, fixture.liveHref(firstHead.documentId));
    await expect(publicPage.getByRole('main')).toContainText(text.selectedBody);
    await expectAbsent(publicPage, text.laterBody, text.laterTitle, text.firstBody, text.parentBody);
    await fixture.open(page, fixture.privateHref(sourceNotebookId, firstHead.documentId));
    await expect(page.locator('.ProseMirror')).toContainText(text.laterBody);
    await expect(page.getByLabel(copy.documentTitle, { exact: true })).toHaveValue(text.laterTitle);
    const history = await fixture.readHistory('public-read', 'alice', alice, sourceNotebookId, firstHead.documentId);
    expect(history.map((row) => row.revisionId).sort()).toEqual(
      [firstHead.revisionId, selectedHead.revisionId, laterHead.revisionId].sort(),
    );

    fixture.evidence.stage = 'reuse';
    await fixture.open(page, fixture.createHref);
    await fixture.fillTitle(page, copy.notebookTitle, text.reuseNotebook);
    await knowledgeJourneyClick(page, copy.createNotebook);
    await fixture.waitStatus(page, copy.notebookAcknowledged);
    const reuseNotebookId = await fixture.labeledValue(page, copy.notebookId);
    expect(isKnowledgeJourneyId(reuseNotebookId)).toBe(true);
    expect(reuseNotebookId).not.toBe(sourceNotebookId);
    fixture.evidence.reuseNotebookId = reuseNotebookId;
    await fixture.fillTitle(page, copy.documentTitle, text.reuseSeedTitle);
    await fixture.fillBody(page, text.reuseSeedBody);
    await fixture.waitEnabled(page, copy.createDocument);
    await knowledgeJourneyClick(page, copy.createDocument);
    await expect(page.getByText(copy.documentAcknowledged).or(page.getByText(copy.currentHead))).toBeVisible();
    const reuseRoot = await fixture.readOutline('reuse', 'alice', alice, reuseNotebookId, null);
    const seedRow = reuseRoot.placements.find((row) => row.title === text.reuseSeedTitle);
    if (!seedRow) throw new Error(`reuse outline omitted seed: ${JSON.stringify(reuseRoot)}`);
    const seed = await fixture.requirePrivateDocument('reuse', 'alice', alice, reuseNotebookId, seedRow.documentId);
    seed.placementId = seedRow.placementId;
    fixture.evidence.reuseSeed = seed;

    await fixture.open(page, fixture.liveHref(firstHead.documentId));
    await expect(page.getByRole('main')).toContainText(text.selectedBody);
    await expectAbsent(page, text.laterBody, text.parentBody, text.firstBody);
    await knowledgeJourneyClick(page, copy.copy);
    await expect(page.getByRole('button', { name: text.reuseNotebook, exact: true })).toBeVisible();
    await page.getByRole('button', { name: text.reuseNotebook, exact: true }).click();
    await expect(page.getByText(text.reuseSeedTitle)).toBeVisible();
    await knowledgeJourneyClick(page, copy.reviewDestination);
    await expect(page.getByText(reuseNotebookId)).toBeVisible();
    await knowledgeJourneyClick(page, copy.confirmCopy);
    await fixture.waitStatus(page, copy.copied);
    const openCopy = page.getByRole('link', { name: copy.openCopy, exact: true });
    await expect(openCopy).toBeVisible();
    const copyHref = await openCopy.getAttribute('href');
    if (!copyHref) throw new Error('reuse copy editor link omitted href');
    const copyMatch = copyHref.match(/\/knowledge\/notebooks\/([0-9a-f-]+)\/documents\/([0-9a-f-]+)/);
    if (!copyMatch) throw new Error(`reuse copy href was not a private document: ${copyHref}`);
    const copiedNotebookId = copyMatch[1]!;
    const copiedDocumentId = copyMatch[2]!;
    expect(copiedNotebookId).toBe(reuseNotebookId);
    expect(copiedDocumentId).not.toBe(firstHead.documentId);
    const copiedOutline = await fixture.readOutline('reuse', 'alice', alice, reuseNotebookId, null);
    const copyRow = copiedOutline.placements.find((row) => row.documentId === copiedDocumentId);
    if (!copyRow) throw new Error(`reuse outline omitted copied document: ${JSON.stringify(copiedOutline)}`);
    expect(copyRow.parentPlacementId).toBeNull();
    const copied = await fixture.requirePrivateDocument('reuse', 'alice', alice, reuseNotebookId, copiedDocumentId);
    copied.placementId = copyRow.placementId;
    expect(copied.notebookId).toBe(reuseNotebookId);
    expect(copied.documentId).toBe(copiedDocumentId);
    expect(copied.revisionId).not.toBe(selectedHead.revisionId);
    expect(copied.publicationId).toBeNull();
    expect(copied.title).toBe(text.selectedTitle);
    expect(copied.body).toBe(selectedBody);
    expect(copied.mediaSources).toEqual(nativePublication.mediaSources);
    expect(copied.sha256).toBe(nativePublication.sha256);
    expect(copied.body).not.toBe(text.laterBody);
    fixture.evidence.copy = copied;
    await openCopy.click();
    await fixture.hydrate(page);
    await expect(page.getByText(copy.currentHead)).toBeVisible();
    await expect(page.getByLabel(copy.documentTitle, { exact: true })).toHaveValue(text.selectedTitle);
    await expect(page.locator('.ProseMirror')).toContainText(text.selectedBody);
    await expectAbsent(page, text.laterBody, text.parentBody, text.firstBody);
    const reopened = asDocument(
      await fixture.readPrivateDocument('reuse', 'alice', alice, reuseNotebookId, copiedDocumentId, 200),
    );
    expect(reopened.revisionId).toBe(copied.revisionId);
    expect(reopened.body).toBe(selectedBody);
    await fixture.requireUnauthorizedPrivate(
      'reuse',
      'bob copied private document',
      'bob',
      alice,
      reuseNotebookId,
      copiedDocumentId,
      [404],
    );
    const copiedPublic = await fixture.readPublicDocument('reuse', copiedDocumentId, undefined, undefined, 404);
    expect('status' in copiedPublic && copiedPublic.status).toBe(404);

    expect(fixture.evidence).toMatchObject({
      stage: 'reuse',
      subjectId,
      sourceNotebookId,
      selectedRevisionId: selectedHead.revisionId,
      selectedPublicationId: publicationId,
      laterRevisionId: laterHead.revisionId,
      reuseNotebookId,
    });
    expect(fixture.evidence.parent?.documentId).toBe(parent.documentId);
    expect(fixture.evidence.child?.documentId).toBe(firstHead.documentId);
    expect(fixture.evidence.copy?.documentId).toBe(copiedDocumentId);
    expect(bob).not.toBe(alice);

    fixture.evidence.stage = 'withdrawal';
    await fixture.open(page, fixture.privateHref(sourceNotebookId, firstHead.documentId));
    await knowledgeJourneyClick(page, 'Review withdrawal');
    await knowledgeJourneyClick(page, 'Withdraw this publication');
    await fixture.waitStatus(
      page,
      'The native withdrawal command was acknowledged. This document has no selected publication.',
    );
    await fixture.open(publicPage, fixture.exactHref(firstHead.documentId, selectedHead.revisionId));
    await expect(publicPage.getByRole('main')).not.toContainText(text.selectedBody);
    await expect(publicPage.locator('img')).toHaveCount(0);
    const withdrawnBytes = await anonymous.request.get(publicImageUrl);
    expect(withdrawnBytes.status()).toBe(404);
    const presented = await fixture.stack.kernel('/v1/media/presentations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [mediaId], knowledge: publicImageSource!.selection }),
    });
    expect(presented.status).toBe(200);
    expect(((await presented.json()) as { images: unknown[] }).images).toEqual([]);
    await fixture.open(page, fixture.privateHref(reuseNotebookId, copiedDocumentId));
    await expect(page.locator('.ProseMirror')).toContainText(text.selectedBody);
    await expect(page.locator('.ProseMirror img')).toHaveCount(0);
    expect(
      (await fixture.requirePrivateDocument('withdrawal', 'alice', alice, reuseNotebookId, copiedDocumentId))
        .mediaSources,
    ).toEqual(copied.mediaSources);
    fixture.evidence.withdrawnMediaUnavailable = true;
  },
  lifecycle,
);
