import { expect, setDefaultTimeout } from 'bun:test';
import type { Page } from 'playwright';
import { documentText, serializeDocument } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  createHostedBookJourneySeed,
  createPrepublishedReaderControl,
  lanternFerryCoverPng,
  readNativePost,
  type HostedBookJourneySeed,
  type HostedReaderControl,
  type JourneyPost,
} from './hosted-book-journey-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(900_000);

const lifecycle = new NativeTestLifecycle('hosted Book author-to-reader journey');
let stack: NativeWebStack;
let auth: NativeAuthStack;

nativeBeforeAll(lifecycle, 600_000, async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
});

nativeAfterAll(lifecycle, 180_000);

type StageState = 'passed' | 'failed' | 'unreached';
type Stage = Readonly<{ label: string; state: StageState; observation: string }>;

class StageJournal {
  private readonly stages: Stage[] = [];

  async run<T>(
    label: string,
    operation: () => Promise<{ value: T; observation: string }>,
    onFailure?: () => Promise<string>,
  ): Promise<T | undefined> {
    try {
      const result = await operation();
      this.stages.push({ label, state: 'passed', observation: result.observation });
      return result.value;
    } catch (cause) {
      let context = '';
      try {
        context = onFailure ? await onFailure() : '';
      } catch (observationError) {
        context = ` failure-observation=${errorText(observationError)}`;
      }
      this.stages.push({
        label,
        state: 'failed',
        observation: `${errorText(cause)}${context ? `; ${context}` : ''}`,
      });
      return undefined;
    }
  }

  unreached(label: string, reason: string) {
    this.stages.push({ label, state: 'unreached', observation: reason });
  }

  async finish(reportName: string) {
    const report = [
      reportName,
      ...this.stages.map(({ label, state, observation }) => `- ${state} | ${label} | ${observation}`),
    ].join('\n');
    console.info(report);
    if (this.stages.some(({ state }) => state === 'failed')) throw new Error(report);
  }
}

type NativeOccurrence = {
  occurrenceId: string;
  parentId: string | null;
  position: number;
  kind: 'part' | 'chapter';
  availability: 'available' | 'unavailable';
  title?: string;
  target?: { threadId: string; postId: string; revisionId: string; sha256: string };
};
type NativeRevision = { catalogueId: string; revisionId: string; kind: string; sourceRevisionId: string | null };
type NativePage = NativeRevision & { items: NativeOccurrence[]; nextCursor: string | null };

function errorText(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

async function pageObservation(page: Page): Promise<string> {
  const alerts = await page
    .getByRole('alert')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const statuses = await page
    .getByRole('status')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return `url=${page.url()} alerts=${JSON.stringify(alerts.slice(-4))} statuses=${JSON.stringify(statuses.slice(-6))}`;
}

async function hydrate(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await page.getByRole('main').waitFor({ state: 'attached' });
}

function pageFrom(journey: { context: { pages(): Page[] } }): Page {
  const page = journey.context.pages().at(-1);
  if (!page) throw new Error('Native sign-in did not retain its private browser page');
  page.setDefaultTimeout(30_000);
  return page;
}

async function saveChapterDraft(
  page: Page,
  seed: HostedBookJourneySeed,
  draft: JourneyPost,
  bodyText: string,
  includeCover: boolean,
) {
  await page.goto(`${stack.web}/en/studio?postId=${encodeURIComponent(draft.postId)}`, {
    waitUntil: 'domcontentloaded',
  });
  await hydrate(page);
  const editor = page.locator('.ProseMirror[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible' });
  await editor.fill(bodyText);

  let mediaId: string | undefined;
  if (includeCover) {
    const reservationPromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
    );
    const uploadPromise = page.waitForResponse(
      (response) =>
        /^\/media\/[0-9a-f-]+$/i.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await page.getByLabel('Choose image file', { exact: true }).setInputFiles({
      name: 'lantern-ferry-cover.png',
      mimeType: 'image/png',
      buffer: lanternFerryCoverPng(),
    });
    await page.getByLabel('Alt text', { exact: true }).fill('Original Lantern Ferry cover');
    await page.getByRole('button', { name: 'Insert image', exact: true }).click();
    const reservation = await reservationPromise;
    expect(reservation.status(), 'the native editor reserves the deterministic cover').toBe(201);
    const result = (await reservation.json()) as { media: { id: string } };
    mediaId = result.media.id;
    const upload = await uploadPromise;
    expect(new URL(upload.url()).pathname).toBe(`/media/${mediaId}`);
    expect(upload.status(), 'the browser uploads the original cover bytes').toBe(200);
    await page.getByRole('img', { name: 'Original Lantern Ferry cover', exact: true }).waitFor({ state: 'visible' });
  }

  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await save.waitFor({ state: 'visible' });
  const readyBy = Date.now() + 30_000;
  while (!(await save.isEnabled()) && Date.now() < readyBy) await Bun.sleep(100);
  expect(await save.isEnabled(), 'the changed exact draft can be saved after its image upload').toBe(true);
  await save.click();
  await page.getByText(/^Saved privately ·/).waitFor({ timeout: 60_000 });

  const post = await readNativePost(seed.author, draft.postId);
  expect(post.revisionId).not.toBe(draft.revisionId);
  expect(post.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(documentText(post.body)).toContain(bodyText);
  if (mediaId) {
    const withMedia = post as typeof post & { mediaIds: readonly string[] };
    expect(withMedia.mediaIds).toContain(mediaId);
  }
  return { post, mediaId };
}

async function readStructure(client: KernelClient, catalogueId: string) {
  const headResult = await client.hostedCatalogues({ id: catalogueId }).get({ query: { kind: 'structure' } });
  if (headResult.status !== 200 || headResult.error || !headResult.data)
    throw new Error(`Generated current Book structure read returned ${headResult.status}`);
  const head = headResult.data as NativeRevision;
  const rootResult = await client.hostedCatalogues({ id: catalogueId }).children.get({
    query: { kind: 'structure', revisionId: head.revisionId, limit: '20' },
  });
  if (rootResult.status !== 200 || rootResult.error || !rootResult.data)
    throw new Error(`Generated Book root occurrence read returned ${rootResult.status}`);
  const root = rootResult.data as NativePage;
  if (root.nextCursor !== null) throw new Error('The Book witness fixture unexpectedly exceeded its root page');
  const items = [...root.items];
  for (const part of root.items.filter((item) => item.kind === 'part' && item.availability === 'available')) {
    const children = await client.hostedCatalogues({ id: catalogueId }).children.get({
      query: { kind: 'structure', revisionId: head.revisionId, parentId: part.occurrenceId, limit: '20' },
    });
    if (children.status !== 200 || children.error || !children.data)
      throw new Error(`Generated Book part read returned ${children.status} for ${part.occurrenceId}`);
    const childPage = children.data as NativePage;
    if (childPage.nextCursor !== null) throw new Error(`Book part ${part.occurrenceId} exceeded its witness page`);
    items.push(...childPage.items);
  }
  return { head, items };
}

async function pickDraft(page: Page, title: string) {
  await page.getByRole('button', { name: 'Open a saved account draft', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
}

async function addChapterFromPicker(page: Page, title: string, draftTitle: string) {
  await pickDraft(page, draftTitle);
  const form = page.locator('details.studio-placement-form');
  await form.locator('summary').click();
  await form.getByLabel('Placement title', { exact: true }).fill(title);
  await form.getByRole('button', { name: 'Add chapter', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).waitFor({ state: 'visible' });
}

async function addPartInStudio(page: Page, title: string) {
  const organizer = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await organizer.waitFor({ state: 'visible' });
  const form = organizer.locator('details.studio-placement-form');
  await form.locator('summary').click();
  await form.getByRole('combobox', { name: 'Add', exact: true }).click();
  await page.getByRole('option', { name: 'Part', exact: true }).click();
  await form.getByLabel('Placement title', { exact: true }).fill(title);
  await form.getByRole('button', { name: 'Add part', exact: true }).click();
  await organizer.getByText(title, { exact: true }).waitFor({ state: 'visible' });
}

async function movePlacementUnderPart(page: Page, placementTitle: string, partTitle: string) {
  const organizer = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await organizer.getByRole('button', { name: `Organize ${placementTitle}`, exact: true }).click();
  await organizer.getByRole('button', { name: 'Move to…', exact: true }).click();
  await organizer.getByRole('combobox', { name: 'Destination', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(partTitle) }).click();
  await organizer.getByRole('button', { name: 'Move placement', exact: true }).click();
  await organizer.getByText(partTitle, { exact: true }).waitFor({ state: 'visible' });
}

async function openBookStudio(page: Page, catalogueId: string) {
  await page.goto(`${stack.web}/en/studio?catalogueId=${encodeURIComponent(catalogueId)}`, {
    waitUntil: 'domcontentloaded',
  });
  await hydrate(page);
  await page.getByRole('region', { name: 'Book table of contents', exact: true }).waitFor({ state: 'visible' });
}

async function assertPublishedBody(
  anonymous: KernelClient,
  catalogueId: string,
  revisionId: string,
  occurrenceId: string,
  target: JourneyPost,
) {
  const result = await anonymous.hostedCatalogues({ id: catalogueId }).occurrences({ occurrenceId }).get({
    query: { revisionId },
  });
  if (result.status !== 200 || result.error || !result.data)
    throw new Error(`Generated anonymous exact occurrence read returned ${result.status}`);
  const response = result.data as {
    occurrence: { occurrenceId: string; kind: string; target: { postId: string; revisionId: string; sha256: string } };
    document: { encoding: string; canonicalBytes: string; sha256: string } | null;
  };
  const bytes = Buffer.from(serializeDocument(target.body), 'utf8');
  expect(response.occurrence.occurrenceId).toBe(occurrenceId);
  expect(response.occurrence.kind).toBe('chapter');
  expect(response.occurrence.target).toMatchObject({
    postId: target.postId,
    revisionId: target.revisionId,
    sha256: target.sha256,
  });
  expect(response.document).toMatchObject({
    encoding: 'base64',
    canonicalBytes: bytes.toString('base64'),
    sha256: target.sha256,
  });
  const root = await anonymous.hostedCatalogues({ id: catalogueId }).children.get({
    query: { kind: 'publication', revisionId, limit: '20' },
  });
  if (root.status !== 200 || root.error || !root.data)
    throw new Error(`Generated anonymous release occurrence list returned ${root.status}`);
  const publicRoot = root.data as { items: { availability: string; kind: string; occurrenceId: string }[] };
  expect(
    publicRoot.items
      .filter((item) => item.kind === 'chapter' && item.availability === 'available')
      .map((item) => item.occurrenceId),
  ).toEqual([occurrenceId]);
  return response;
}

function nativeStatus(result: { status: number }) {
  return result.status;
}

nativeTest(
  'mounted private Book drafts save, organize, explicitly publish one exact version, and retain the older reader link',
  900_000,
  async () => {
    const journal = new StageJournal();
    let seed: HostedBookJourneySeed | undefined;
    let chapterOne: Awaited<ReturnType<typeof readNativePost>> | undefined;
    let chapterTwo: Awaited<ReturnType<typeof readNativePost>> | undefined;
    let catalogueId: string | undefined;
    let partTitle: string | undefined;
    let chapterOneTitle: string | undefined;
    let chapterTwoTitle: string | undefined;
    let chapterOneOccurrence: string | undefined;
    let chapterTwoOccurrence: string | undefined;
    let releaseRevisionId: string | undefined;
    let oldReaderHref: string | undefined;
    const ownerJourney = await auth.signIn('alice');
    const page = pageFrom(ownerJourney);
    await page.setViewportSize({ width: 1440, height: 1000 });

    seed = await journal.run('generated private manuscript setup', async () => {
      const value = await createHostedBookJourneySeed(stack, 'Private draft journey');
      return {
        value,
        observation: `subject=${value.subjectId} opening=${value.opening.postId} chapters=${value.chapterOne.postId},${value.chapterTwo.postId}`,
      };
    });

    const oneText = 'Mara counted the lanterns from the ferry deck and marked the quiet harbor on her chart.';
    if (seed) {
      const saved = await journal.run(
        'save chapter one and upload the deterministic original cover in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!, seed!.chapterOne, oneText, true);
          chapterOne = result.post;
          return {
            value: result.post,
            observation: `post=${result.post.id} revision=${result.post.revisionId} sha256=${result.post.sha256} media=${result.mediaId}`,
          };
        },
        () => pageObservation(page),
      );
      if (!saved)
        journal.unreached('chapter one saved-version readback', 'Studio save and generated readback did not complete');
      const twoText = 'At first light, the ferryman found Mara’s map tucked beneath the warm brass lantern.';
      const second = await journal.run(
        'save chapter two as a separate private exact draft in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!, seed!.chapterTwo, twoText, false);
          chapterTwo = result.post;
          return {
            value: result.post,
            observation: `post=${result.post.id} revision=${result.post.revisionId} sha256=${result.post.sha256}`,
          };
        },
        () => pageObservation(page),
      );
      if (!second)
        journal.unreached('chapter two saved-version readback', 'Studio save and generated readback did not complete');

      await journal.run('anonymous direct reads conceal all private chapter drafts before release', async () => {
        const firstDirect = await seed!.anonymous.posts({ id: seed!.chapterOne.postId }).get();
        const secondDirect = await seed!.anonymous.posts({ id: seed!.chapterTwo.postId }).get();
        expect(nativeStatus(firstDirect)).toBe(404);
        expect(nativeStatus(secondDirect)).toBe(404);
        return {
          value: true,
          observation: `chapter-one=${firstDirect.status} chapter-two=${secondDirect.status}`,
        };
      });

      const book = await journal.run(
        'start the private Book from the saved opening in Studio',
        async () => {
          await page.goto(`${stack.web}/en/studio?postId=${encodeURIComponent(seed!.opening.postId)}`, {
            waitUntil: 'domcontentloaded',
          });
          await hydrate(page);
          await page.getByRole('button', { name: 'Start a Book', exact: true }).click();
          await page.waitForURL((url) => url.searchParams.has('catalogueId'), { timeout: 90_000 });
          await page.getByRole('region', { name: 'Book table of contents', exact: true }).waitFor({ state: 'visible' });
          const id = new URL(page.url()).searchParams.get('catalogueId');
          if (!id) throw new Error('Start a Book did not navigate to the admitted owner Book');
          catalogueId = id;
          return { value: id, observation: `catalogue=${id} url=${page.url()}` };
        },
        () => pageObservation(page),
      );
      if (!book)
        journal.unreached('Book Studio saved chapter placement', 'Book start did not reach its admitted owner route');

      if (book && chapterOne) {
        chapterOneTitle = 'Lanterns at Low Tide';
        await journal.run(
          'place the saved chapter one version through the Book Studio picker',
          async () => {
            await addChapterFromPicker(page, chapterOneTitle!, seed!.chapterOne.title);
            const outline = await readStructure(seed!.author, catalogueId!);
            const placement = outline.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterOne!.id,
            );
            if (!placement) throw new Error('Book structure readback omitted the selected saved chapter one Post');
            expect(placement.target).toMatchObject({
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
            });
            chapterOneOccurrence = placement.occurrenceId;
            return {
              value: placement,
              observation: `occurrence=${placement.occurrenceId} parent=${placement.parentId} exact=${placement.target?.revisionId}`,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached(
          'Book Studio chapter one placement',
          'Book start or chapter one saved-version readback failed',
        );
      }

      if (book) {
        partTitle = 'Under the Lanterns';
        await journal.run(
          'create a part through the Book Studio outline',
          async () => {
            await addPartInStudio(page, partTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            if (!part) throw new Error(`Generated Book structure readback omitted part ${partTitle}`);
            return { value: part, observation: `part=${part.occurrenceId} position=${part.position}` };
          },
          () => pageObservation(page),
        );
      } else journal.unreached('Book Studio part creation', 'Book start did not reach its admitted owner route');

      if (book && chapterTwo) {
        chapterTwoTitle = 'The Ferry Map';
        await journal.run(
          'append the second saved draft at Book root through native Root Append',
          async () => {
            await page.goto(`${stack.web}/en/studio?catalogueId=${encodeURIComponent(catalogueId!)}&append=1`, {
              waitUntil: 'domcontentloaded',
            });
            await hydrate(page);
            await page
              .getByRole('heading', { name: 'Append a saved chapter', exact: true })
              .waitFor({ state: 'visible' });
            await pickDraft(page, seed!.chapterTwo.title);
            await page.getByLabel('Chapter title', { exact: true }).fill(chapterTwoTitle!);
            await page.getByRole('button', { name: 'Review append', exact: true }).click();
            await page.getByRole('button', { name: 'Append this saved chapter', exact: true }).click();
            await page.getByText(/Chapter append acknowledged/u).waitFor({ state: 'visible' });
            await openBookStudio(page, catalogueId!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const placement = outline.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterTwo!.id,
            );
            if (!placement) throw new Error('Generated Book structure readback omitted the root-appended second Post');
            expect(placement.parentId).toBeNull();
            expect(placement.target).toMatchObject({
              revisionId: chapterTwo!.revisionId,
              sha256: chapterTwo!.sha256,
            });
            chapterTwoOccurrence = placement.occurrenceId;
            return {
              value: placement,
              observation: `occurrence=${placement.occurrenceId} parent=${placement.parentId} exact=${placement.target?.revisionId}`,
            };
          },
          () => pageObservation(page),
        );
      } else journal.unreached('native Root Append', 'Book start or chapter two saved-version readback failed');

      if (book && chapterTwo && partTitle && chapterTwoTitle) {
        await journal.run(
          'move the root-appended exact placement into its part in Book Studio',
          async () => {
            await openBookStudio(page, catalogueId!);
            await movePlacementUnderPart(page, chapterTwoTitle!, partTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            const moved = outline.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterTwo!.id,
            );
            if (
              !part ||
              !moved ||
              moved.parentId !== part.occurrenceId ||
              moved.occurrenceId !== chapterTwoOccurrence ||
              moved.target?.revisionId !== chapterTwo!.revisionId ||
              moved.target.sha256 !== chapterTwo!.sha256
            )
              throw new Error(
                `Generated structure did not retain nested exact placement: ${JSON.stringify({ part, moved })}`,
              );
            return {
              value: moved,
              observation: `occurrence=${moved.occurrenceId} parent=${moved.parentId} part=${part.occurrenceId}`,
            };
          },
          () => pageObservation(page),
        );
      } else journal.unreached('move and nest the second placement', 'Root Append or part creation did not complete');

      if (book && chapterOne && chapterTwo && chapterOneOccurrence && chapterOneTitle && chapterTwoTitle) {
        const publication = await journal.run(
          'review and explicitly publish only the selected private saved version',
          async () => {
            await openBookStudio(page, catalogueId!);
            const selection = page.getByRole('checkbox', {
              name: `Include ${chapterOneTitle} in the next release`,
              exact: true,
            });
            await selection.click();
            expect(await selection.isChecked()).toBe(true);
            await page.getByRole('button', { name: 'Review publication…', exact: true }).click();
            await page.getByRole('heading', { name: 'Review this release', exact: true }).waitFor({ state: 'visible' });
            const review = page.locator('.studio-release-review');
            const reviewText = await review.innerText();
            expect(reviewText).toContain(chapterOneTitle!);
            expect(reviewText).not.toContain(chapterTwoTitle!);
            expect(reviewText).not.toContain(seed!.opening.title);
            await review.getByText('Exact document version', { exact: true }).click();
            const exactReviewText = await review.innerText();
            expect(exactReviewText).toContain(chapterOne!.revisionId);
            expect(exactReviewText).toContain(chapterOne!.sha256);
            expect(exactReviewText).not.toContain(chapterTwo.revisionId);
            await page
              .getByRole('checkbox', {
                name: 'I have reviewed these exact versions and want to publish this release.',
                exact: true,
              })
              .click();
            await page.getByRole('button', { name: 'Publish reviewed chapters', exact: true }).click();
            await page.getByText(/^Published snapshot /u).waitFor({ state: 'visible', timeout: 90_000 });
            const head = await seed!.author.hostedCatalogues({ id: catalogueId! }).get({
              query: { kind: 'publication' },
            });
            if (head.status !== 200 || head.error || !head.data)
              throw new Error(`Generated owner publication readback returned ${head.status}`);
            const readback = head.data as NativeRevision;
            releaseRevisionId = readback.revisionId;
            return {
              value: readback,
              observation: `release=${readback.revisionId} selected=${chapterOneTitle} excluded=${chapterTwoTitle}`,
            };
          },
          () => pageObservation(page),
        );
        if (!publication)
          journal.unreached(
            'private selected-version publication receipt',
            'Studio did not acknowledge the explicit selected-version publication',
          );
      } else {
        journal.unreached(
          'review and explicitly publish selected version',
          'Both saved chapter versions and chapter one’s exact placement are required before release review',
        );
      }

      if (releaseRevisionId && chapterOne && chapterTwo && chapterOneOccurrence && catalogueId) {
        await journal.run('anonymous native release occurrence returns the exact saved public body', async () => {
          const body = await assertPublishedBody(
            seed!.anonymous,
            catalogueId!,
            releaseRevisionId!,
            chapterOneOccurrence!,
            {
              ...seed!.chapterOne,
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
              body: chapterOne!.body,
            },
          );
          return {
            value: body,
            observation: `occurrence=${chapterOneOccurrence} release=${releaseRevisionId} sha256=${body.document?.sha256}`,
          };
        });
        await journal.run(
          'anonymous direct Post stays private while selected release and remaining draft stay separate',
          async () => {
            const selectedDirect = await seed!.anonymous.posts({ id: chapterOne!.id }).get();
            const remainingDirect = await seed!.anonymous.posts({ id: chapterTwo!.postId }).get();
            expect(selectedDirect.status).toBe(404);
            expect(remainingDirect.status).toBe(404);
            const current = await readStructure(seed!.author, catalogueId!);
            const remaining = current.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterTwo!.postId,
            );
            expect(remaining).toBeDefined();
            expect(remaining?.target?.revisionId).toBe(chapterTwo!.revisionId);
            return {
              value: true,
              observation: `selected-direct=${selectedDirect.status} remaining-direct=${remainingDirect.status} remaining-placement=${remaining?.occurrenceId ?? 'not-placed'}`,
            };
          },
        );

        await journal.run(
          'capture the published exact reader link through subject discovery',
          async () => {
            const catalogues = await seed!.author.subjects({ id: seed!.subjectId }).hostedCatalogues.get({
              query: { limit: '20' },
            });
            if (catalogues.status !== 200 || catalogues.error || !catalogues.data)
              throw new Error(`Generated Book subject discovery returned ${catalogues.status}`);
            const pageData = catalogues.data as { items: { catalogueId: string; revisionId: string }[] };
            const index = pageData.items.findIndex(
              (item) => item.catalogueId === catalogueId && item.revisionId === releaseRevisionId,
            );
            if (index < 0) throw new Error('Current Book discovery omitted the exact published Book revision');
            await page.goto(`${stack.web}/en/books/${encodeURIComponent(seed!.subjectId)}/read?view=catalogues`, {
              waitUntil: 'domcontentloaded',
            });
            await hydrate(page);
            await page.getByRole('link', { name: `Published book ${index + 1}`, exact: true }).click();
            await page.getByRole('link', { name: /Read chapter/ }).waitFor({ state: 'visible' });
            await page.getByRole('link', { name: /Read chapter/ }).click();
            await page.getByRole('heading', { name: chapterOneTitle!, exact: true }).waitFor({ state: 'visible' });
            oldReaderHref = page.url();
            return { value: oldReaderHref, observation: `discovery-index=${index + 1} exact-url=${oldReaderHref}` };
          },
          () => pageObservation(page),
        );

        await journal.run(
          'move the published occurrence later and preserve its emitted exact reader link',
          async () => {
            if (!partTitle || !oldReaderHref)
              throw new Error('A selected published occurrence or reader link was not admitted');
            await openBookStudio(page, catalogueId!);
            await movePlacementUnderPart(page, chapterOneTitle!, partTitle);
            const outline = await readStructure(seed!.author, catalogueId!);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            const moved = outline.items.find((item) => item.occurrenceId === chapterOneOccurrence);
            if (!part || !moved || moved.parentId !== part.occurrenceId)
              throw new Error('The moved selected occurrence did not retain its native placement identity');
            const historical = await assertPublishedBody(
              seed!.anonymous,
              catalogueId!,
              releaseRevisionId!,
              chapterOneOccurrence!,
              {
                ...seed!.chapterOne,
                revisionId: chapterOne!.revisionId,
                sha256: chapterOne!.sha256,
                body: chapterOne!.body,
              },
            );
            const anonymous = await auth.context('anonymous');
            const reader = await anonymous.newPage();
            await reader.goto(oldReaderHref!, { waitUntil: 'domcontentloaded' });
            await hydrate(reader);
            await reader.getByRole('heading', { name: chapterOneTitle!, exact: true }).waitFor({ state: 'visible' });
            await reader.getByText(oneText, { exact: true }).waitFor({ state: 'visible' });
            return {
              value: historical,
              observation: `moved-parent=${moved.parentId} old-release=${releaseRevisionId} old-url=${oldReaderHref} sha256=${historical.document?.sha256}`,
            };
          },
          () => pageObservation(page),
        );

        await journal.run(
          'withdraw the reviewed Book release and retain drafts and its old exact link',
          async () => {
            await openBookStudio(page, catalogueId!);
            await page.getByRole('button', { name: 'Review Book withdrawal…', exact: true }).click();
            await page
              .getByRole('heading', { name: 'Review Book withdrawal', exact: true })
              .waitFor({ state: 'visible' });
            await page
              .getByRole('checkbox', {
                name: 'I want to withdraw this exact current release from discovery.',
                exact: true,
              })
              .click();
            await page.getByRole('button', { name: 'Withdraw reviewed Book', exact: true }).click();
            await page.getByText('The Book was withdrawn from current discovery.', { exact: true }).waitFor({
              state: 'visible',
              timeout: 90_000,
            });
            const current = await seed!.anonymous.subjects({ id: seed!.subjectId }).hostedCatalogues.get({
              query: { limit: '20' },
            });
            if (current.status !== 200 || current.error || !current.data)
              throw new Error(`Generated post-withdrawal discovery read returned ${current.status}`);
            const rows = current.data as { items: { catalogueId: string }[] };
            expect(rows.items.some((item) => item.catalogueId === catalogueId)).toBe(false);
            const historical = await assertPublishedBody(
              seed!.anonymous,
              catalogueId!,
              releaseRevisionId!,
              chapterOneOccurrence!,
              {
                ...seed!.chapterOne,
                revisionId: chapterOne!.revisionId,
                sha256: chapterOne!.sha256,
                body: chapterOne!.body,
              },
            );
            const remaining = await seed!.anonymous.posts({ id: chapterTwo!.postId }).get();
            expect(remaining.status).toBe(404);
            const draftStructure = await readStructure(seed!.author, catalogueId!);
            const remainingPlacement = draftStructure.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterTwo!.postId,
            );
            const selectedPlacement = draftStructure.items.find(
              (item) => item.kind === 'chapter' && item.occurrenceId === chapterOneOccurrence,
            );
            expect(remainingPlacement?.target).toMatchObject({
              revisionId: chapterTwo!.revisionId,
              sha256: chapterTwo!.sha256,
            });
            expect(selectedPlacement?.target).toMatchObject({
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
            });
            if (oldReaderHref) {
              const anonymous = await auth.context('anonymous');
              const reader = await anonymous.newPage();
              await reader.goto(oldReaderHref, { waitUntil: 'domcontentloaded' });
              await hydrate(reader);
              await reader.getByRole('heading', { name: chapterOneTitle!, exact: true }).waitFor({ state: 'visible' });
              await reader.getByText(oneText, { exact: true }).waitFor({ state: 'visible' });
            }
            return {
              value: true,
              observation: `discovery-current=${rows.items.length} remaining-post=${remaining.status} retained-drafts=${selectedPlacement?.target?.revisionId},${remainingPlacement?.target?.revisionId} historical-sha256=${historical.document?.sha256} old-url=${oldReaderHref ?? 'unavailable'}`,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached(
          'native public occurrence and exact body',
          'Studio did not return an exact public release receipt',
        );
        journal.unreached('selected and remaining direct Post privacy', 'No release receipt was available to compare');
        journal.unreached('reader discovery and old-link stability', 'No public revision was available to open');
        journal.unreached('withdrawal and post-withdrawal history', 'No published release was available to review');
      }
    } else {
      for (const label of [
        'save chapter one and upload the deterministic original cover in Studio',
        'save chapter two as a separate private exact draft in Studio',
        'anonymous direct reads conceal all private chapter drafts before release',
        'start the private Book from the saved opening in Studio',
        'Book Studio saved chapter placement',
        'Book Studio part creation',
        'native Root Append',
        'move and nest the second placement',
        'review and explicitly publish selected version',
        'native public occurrence, exact reader link, remaining drafts and withdrawal',
      ])
        journal.unreached(label, 'Generated private fixture setup did not complete');
    }

    await journal.finish('PRIVATE-DRAFT BOOK JOURNEY');
  },
  lifecycle,
);

nativeTest(
  'separate prepublished one-chapter control exercises anonymous reader, Library continue, old links, and withdrawal',
  900_000,
  async () => {
    const journal = new StageJournal();
    let control: HostedReaderControl | undefined;
    let exactReaderHref: string | undefined;
    let partTitle = 'Later control contents';

    control = await journal.run('separate one-chapter prepublished control setup', async () => {
      const value = await createPrepublishedReaderControl(stack);
      return {
        value,
        observation: `control=catalogue:${value.catalogueId} subject:${value.subjectId} one-selected-occurrence:${value.occurrenceId} release:${value.publicationRevisionId}`,
      };
    });
    if (!control) {
      for (const label of [
        'anonymous public occurrence and exact body',
        'member saves and resumes a reading checkpoint',
        'anonymous direct exact-reader link after a later move',
        'ordinary Studio withdrawal removes current discovery and preserves history',
      ])
        journal.unreached(label, 'The separate generated one-chapter reader control was not created');
      await journal.finish('PREPUBLISHED READER CONTROL');
      return;
    }

    await journal.run('control chapter Post remains private behind the public Book occurrence', async () => {
      const anonymousPost = await control!.anonymous.posts({ id: control!.chapter.postId }).get();
      expect(anonymousPost.status).toBe(404);
      return {
        value: true,
        observation: `direct-post=${anonymousPost.status} hosted-occurrence=${control!.occurrenceId}`,
      };
    });

    const occurrence = await journal.run('control anonymous occurrence returns its original exact body', async () => {
      const data = await assertPublishedBody(
        control!.anonymous,
        control!.catalogueId,
        control!.publicationRevisionId,
        control!.occurrenceId,
        control!.chapter,
      );
      return {
        value: data,
        observation: `occurrence=${control!.occurrenceId} release=${control!.publicationRevisionId} sha256=${data.document?.sha256}`,
      };
    });

    const memberJourney = await auth.signIn('bob');
    const memberPage = pageFrom(memberJourney);
    await memberPage.setViewportSize({ width: 1280, height: 900 });
    const discovery = await journal.run(
      'member opens the control through current Book subject discovery',
      async () => {
        const listing = await control!.member.subjects({ id: control!.subjectId }).hostedCatalogues.get({
          query: { limit: '20' },
        });
        if (listing.status !== 200 || listing.error || !listing.data)
          throw new Error(`Generated member Book discovery returned ${listing.status}`);
        const body = listing.data as { items: { catalogueId: string; revisionId: string }[] };
        const index = body.items.findIndex(
          (item) => item.catalogueId === control!.catalogueId && item.revisionId === control!.publicationRevisionId,
        );
        if (index < 0) throw new Error('Generated Book subject discovery omitted the separate control');
        await memberPage.goto(`${stack.web}/en/books/${encodeURIComponent(control!.subjectId)}/read?view=catalogues`, {
          waitUntil: 'domcontentloaded',
        });
        await hydrate(memberPage);
        await memberPage.getByRole('link', { name: `Published book ${index + 1}`, exact: true }).click();
        await memberPage.getByRole('link', { name: /Read chapter/ }).click();
        await memberPage
          .getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true })
          .waitFor({
            state: 'visible',
          });
        await memberPage.getByText(documentText(control!.chapter.body), { exact: true }).waitFor({ state: 'visible' });
        exactReaderHref = memberPage.url();
        return { value: exactReaderHref, observation: `discovery-index=${index + 1} exact-url=${exactReaderHref}` };
      },
      () => pageObservation(memberPage),
    );

    if (discovery && occurrence) {
      await journal.run(
        'member saves and resumes the exact hosted chapter through the Library checkpoint',
        async () => {
          const visibleBlock = memberPage.locator('[data-block-id]').filter({ visible: true }).first();
          const visibleBlockId = await visibleBlock.getAttribute('data-block-id');
          if (!visibleBlockId) throw new Error('The mounted chapter has no visible stable document block');
          await memberPage.getByRole('button', { name: 'Save visible block', exact: true }).click();
          await memberPage.getByText('Reading position saved.', { exact: true }).waitFor({ state: 'visible' });
          const checkpoint = await control!.member.libraryHostedReading.metadata.get({
            query: { subjectId: control!.subjectId },
          });
          if (checkpoint.status !== 200 || checkpoint.error || !checkpoint.data)
            throw new Error(`Generated member checkpoint readback returned ${checkpoint.status}`);
          const saved = checkpoint.data as {
            state: string;
            subjectId: string;
            address: {
              catalogueId: string;
              publicationRevisionId: string;
              occurrenceId: string;
              targetRevisionId: string;
              targetSha256: string;
              documentPosition: { blockId: string; offset: number } | null;
            };
          };
          expect(saved).toMatchObject({
            state: 'saved',
            subjectId: control!.subjectId,
            address: {
              catalogueId: control!.catalogueId,
              publicationRevisionId: control!.publicationRevisionId,
              occurrenceId: control!.occurrenceId,
              targetRevisionId: control!.chapter.revisionId,
              targetSha256: control!.chapter.sha256,
              documentPosition: { blockId: visibleBlockId, offset: 0 },
            },
          });
          await memberPage.reload({ waitUntil: 'domcontentloaded' });
          await hydrate(memberPage);
          await memberPage
            .getByRole('link', { name: 'Resume saved chapter', exact: true })
            .waitFor({ state: 'visible' });
          await memberPage.getByRole('link', { name: 'Resume saved chapter', exact: true }).click();
          await memberPage.waitForURL((url) => url.searchParams.get('occurrence') === control!.occurrenceId);
          await memberPage
            .getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true })
            .waitFor({
              state: 'visible',
            });
          exactReaderHref = memberPage.url();
          return {
            value: saved,
            observation: `state=${saved.state} subject=${saved.subjectId} occurrence=${saved.address.occurrenceId} block=${saved.address.documentPosition?.blockId} resumed=${exactReaderHref}`,
          };
        },
        () => pageObservation(memberPage),
      );
    } else {
      journal.unreached(
        'member save and continue checkpoint',
        'Control occurrence or visible discovery reader did not open',
      );
    }

    if (discovery && exactReaderHref) {
      await journal.run('anonymous direct exact-reader address returns the selected control body', async () => {
        const anonymous = await auth.context('anonymous');
        const page = await anonymous.newPage();
        page.setDefaultTimeout(30_000);
        await page.goto(exactReaderHref!, { waitUntil: 'domcontentloaded' });
        await hydrate(page);
        await page.getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true }).waitFor({
          state: 'visible',
        });
        await page.getByText(documentText(control!.chapter.body), { exact: true }).waitFor({ state: 'visible' });
        return { value: page.url(), observation: `status=mounted visible-body=true exact-url=${page.url()}` };
      });

      const ownerJourney = await auth.signIn('alice');
      const ownerPage = pageFrom(ownerJourney);
      await ownerPage.setViewportSize({ width: 1440, height: 1000 });
      await journal.run(
        'move the control placement after publication through Book Studio',
        async () => {
          await openBookStudio(ownerPage, control!.catalogueId);
          await addPartInStudio(ownerPage, partTitle);
          await movePlacementUnderPart(ownerPage, 'Control chapter · Beside the harbor steps', partTitle);
          const current = await readStructure(control!.author, control!.catalogueId);
          const part = current.items.find((item) => item.kind === 'part' && item.title === partTitle);
          const moved = current.items.find((item) => item.occurrenceId === control!.occurrenceId);
          if (!part || !moved || moved.parentId !== part.occurrenceId)
            throw new Error('Control structure did not retain the same occurrence after moving it');
          return {
            value: moved,
            observation: `occurrence=${moved.occurrenceId} parent=${moved.parentId} part=${part.occurrenceId}`,
          };
        },
        () => pageObservation(ownerPage),
      );

      await journal.run('the emitted old reader URL still serves its exact release after a later move', async () => {
        const page = await (await auth.context('anonymous')).newPage();
        page.setDefaultTimeout(30_000);
        await page.goto(exactReaderHref!, { waitUntil: 'domcontentloaded' });
        await hydrate(page);
        await page.getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true }).waitFor({
          state: 'visible',
        });
        await page.getByText(documentText(control!.chapter.body), { exact: true }).waitFor({ state: 'visible' });
        const exact = await assertPublishedBody(
          control!.anonymous,
          control!.catalogueId,
          control!.publicationRevisionId,
          control!.occurrenceId,
          control!.chapter,
        );
        return {
          value: exact,
          observation: `old-url=${exactReaderHref} historical-occurrence=${control!.occurrenceId} sha256=${exact.document?.sha256}`,
        };
      });

      await journal.run(
        'withdraw the control through Studio and preserve its old exact release',
        async () => {
          await openBookStudio(ownerPage, control!.catalogueId);
          await ownerPage.getByRole('button', { name: 'Review Book withdrawal…', exact: true }).click();
          await ownerPage
            .getByRole('heading', { name: 'Review Book withdrawal', exact: true })
            .waitFor({ state: 'visible' });
          await ownerPage
            .getByRole('checkbox', {
              name: 'I want to withdraw this exact current release from discovery.',
              exact: true,
            })
            .click();
          await ownerPage.getByRole('button', { name: 'Withdraw reviewed Book', exact: true }).click();
          await ownerPage.getByText('The Book was withdrawn from current discovery.', { exact: true }).waitFor({
            state: 'visible',
            timeout: 90_000,
          });
          const current = await control!.anonymous.subjects({ id: control!.subjectId }).hostedCatalogues.get({
            query: { limit: '20' },
          });
          if (current.status !== 200 || current.error || !current.data)
            throw new Error(`Generated post-withdrawal control discovery returned ${current.status}`);
          const discoveryPage = current.data as { items: { catalogueId: string }[] };
          expect(discoveryPage.items.some((item) => item.catalogueId === control!.catalogueId)).toBe(false);
          const historical = await assertPublishedBody(
            control!.anonymous,
            control!.catalogueId,
            control!.publicationRevisionId,
            control!.occurrenceId,
            control!.chapter,
          );
          const page = await (await auth.context('anonymous')).newPage();
          page.setDefaultTimeout(30_000);
          await page.goto(exactReaderHref!, { waitUntil: 'domcontentloaded' });
          await hydrate(page);
          await page.getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true }).waitFor({
            state: 'visible',
          });
          await page.getByText(documentText(control!.chapter.body), { exact: true }).waitFor({ state: 'visible' });
          return {
            value: true,
            observation: `current-discovery=${discoveryPage.items.length} historical-occurrence=${control!.occurrenceId} sha256=${historical.document?.sha256} old-url=${exactReaderHref}`,
          };
        },
        () => pageObservation(ownerPage),
      );
    } else {
      for (const label of [
        'anonymous direct exact-reader address after a later move',
        'move the control placement after publication through Book Studio',
        'old reader link after a later move',
        'withdrawal of the prepublished control through Studio',
      ])
        journal.unreached(label, 'Member discovery did not establish the exact control reader link');
    }

    await journal.finish('PREPUBLISHED READER CONTROL (separate from private-draft outcome)');
  },
  lifecycle,
);
