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
  author: KernelClient,
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

  const post = await readNativePost(author, draft.postId);
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

async function movePlacementUp(page: Page, placementTitle: string) {
  const organizer = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await organizer.getByRole('button', { name: `Organize ${placementTitle}`, exact: true }).click();
  await organizer.getByRole('button', { name: `Move up ${placementTitle}`, exact: true }).click();
}

async function openBookStudio(page: Page, catalogueId: string) {
  await page.goto(`${stack.web}/en/studio?catalogueId=${encodeURIComponent(catalogueId)}`, {
    waitUntil: 'domcontentloaded',
  });
  await hydrate(page);
  await page.getByRole('region', { name: 'Book table of contents', exact: true }).waitFor({ state: 'visible' });
}

async function readOwnedBook(client: KernelClient, accountId: string, catalogueId: string) {
  const result = await client.accounts({ accountId }).hostedCatalogues({ id: catalogueId }).get();
  if (result.status !== 200 || result.error || !result.data)
    throw new Error(`Generated exact Book owner read returned ${result.status}`);
  const owner = result.data as {
    viewer: { accountId: string; authnEpoch: number };
    item: { catalogueId: string; headRevisionId: string; publicationId: string | null };
  };
  if (owner.viewer.accountId !== accountId || owner.item.catalogueId !== catalogueId)
    throw new Error('Generated exact Book owner read changed its account or catalogue identity');
  return owner;
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
  ).toContain(occurrenceId);
  return response;
}

function nativeStatus(result: { status: number }) {
  return result.status;
}

nativeTest(
  'mounted private Book drafts save, compare, preview, prepare an exact selection, and journal the missing initial activation',
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
    let stageId: string | undefined;
    let preparationOperands: string | undefined;
    let candidateSealed = false;
    const ownerJourney = await auth.signIn('alice');
    const page = pageFrom(ownerJourney);
    await page.setViewportSize({ width: 1440, height: 1000 });

    seed = await journal.run('generated private manuscript setup', async () => {
      const value = await createHostedBookJourneySeed(stack, 'Private draft journey');
      return {
        value,
        observation:
          'subject=' +
          value.subjectId +
          ' author=' +
          value.authorAccountId +
          ' member=' +
          value.memberAccountId +
          ' opening=' +
          value.opening.postId +
          ' chapters=' +
          value.chapterOne.postId +
          ',' +
          value.chapterTwo.postId,
      };
    });

    const oneText = 'Mara counted the lanterns from the ferry deck and marked the quiet harbor on her chart.';
    if (seed) {
      const saved = await journal.run(
        'save chapter one and upload the deterministic original cover in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!.author, seed!.chapterOne, oneText, true);
          chapterOne = result.post;
          return {
            value: result.post,
            observation:
              'post=' +
              result.post.id +
              ' revision=' +
              result.post.revisionId +
              ' sha256=' +
              result.post.sha256 +
              ' media=' +
              result.mediaId,
          };
        },
        () => pageObservation(page),
      );
      if (!saved)
        journal.unreached('chapter one saved-version readback', 'Studio save and generated readback did not complete');

      if (saved) {
        await journal.run(
          'preview the saved chapter privately through the mounted Studio view',
          async () => {
            await page.getByRole('button', { name: 'Preview', exact: true }).click();
            const preview = page.getByRole('region', { name: 'Private draft preview', exact: true });
            await preview.getByText(oneText, { exact: true }).waitFor({ state: 'visible' });
            await preview.getByText('Private preview · saved draft version', { exact: true }).waitFor({
              state: 'visible',
            });
            return {
              value: true,
              observation: 'saved-revision=' + chapterOne!.revisionId + ' preview-body-visible=true',
            };
          },
          () => pageObservation(page),
        );

        await journal.run(
          'compare the original and current saved chapter revisions in Studio',
          async () => {
            await page.getByRole('button', { name: 'Versions', exact: true }).click();
            const versions = page.getByRole('region', { name: 'Document versions', exact: true });
            await versions.getByRole('button', { name: 'Load saved versions', exact: true }).click();
            const original = versions.locator('li').filter({ hasText: seed!.chapterOne.revisionId });
            await original.getByRole('button', { name: /^Compare /u }).click();
            await versions.getByRole('heading', { name: 'Selected version', exact: true }).waitFor({
              state: 'visible',
            });
            await versions.getByRole('heading', { name: 'Current saved draft', exact: true }).waitFor({
              state: 'visible',
            });
            await versions.getByText(documentText(seed!.chapterOne.body), { exact: true }).waitFor({
              state: 'visible',
            });
            await versions.getByText(oneText, { exact: true }).waitFor({ state: 'visible' });
            expect(await original.innerText()).toContain(seed!.chapterOne.revisionId);
            return {
              value: true,
              observation:
                'compared=' +
                seed!.chapterOne.revisionId +
                ' against=' +
                chapterOne!.revisionId +
                ' original-and-current-bodies-visible=true',
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached(
          'private saved chapter preview and revision comparison',
          'Chapter one did not save a native exact version',
        );
      }

      const twoText = 'At first light, the ferryman found Mara’s map tucked beneath the warm brass lantern.';
      const second = await journal.run(
        'save chapter two as a separate private exact draft in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!.author, seed!.chapterTwo, twoText, false);
          chapterTwo = result.post;
          return {
            value: result.post,
            observation:
              'post=' + result.post.id + ' revision=' + result.post.revisionId + ' sha256=' + result.post.sha256,
          };
        },
        () => pageObservation(page),
      );
      if (!second)
        journal.unreached('chapter two saved-version readback', 'Studio save and generated readback did not complete');

      await journal.run('anonymous direct reads conceal private chapter drafts before release', async () => {
        const firstDirect = await seed!.anonymous.posts({ id: seed!.chapterOne.postId }).get();
        const secondDirect = await seed!.anonymous.posts({ id: seed!.chapterTwo.postId }).get();
        expect(nativeStatus(firstDirect)).toBe(404);
        expect(nativeStatus(secondDirect)).toBe(404);
        return {
          value: true,
          observation: 'chapter-one=' + firstDirect.status + ' chapter-two=' + secondDirect.status,
        };
      });

      const book = await journal.run(
        'start the private Book from the saved opening in Studio',
        async () => {
          await page.goto(stack.web + '/en/studio?postId=' + encodeURIComponent(seed!.opening.postId), {
            waitUntil: 'domcontentloaded',
          });
          await hydrate(page);
          await page.getByRole('button', { name: 'Start a Book', exact: true }).click();
          await page.waitForURL((url) => url.searchParams.has('catalogueId'), { timeout: 90_000 });
          await page.getByRole('region', { name: 'Book table of contents', exact: true }).waitFor({ state: 'visible' });
          const id = new URL(page.url()).searchParams.get('catalogueId');
          if (!id) throw new Error('Start a Book did not navigate to the admitted owner Book');
          catalogueId = id;
          const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, id);
          const structure = await readStructure(seed!.author, id);
          expect(owner.item.headRevisionId).toBe(structure.head.revisionId);
          expect(owner.item.publicationId).toBeNull();
          return {
            value: id,
            observation:
              'catalogue=' +
              id +
              ' owner=' +
              owner.viewer.accountId +
              '@' +
              owner.viewer.authnEpoch +
              ' draft=' +
              owner.item.headRevisionId +
              ' publication=null',
          };
        },
        () => pageObservation(page),
      );
      if (!book)
        journal.unreached(
          'Book Studio chapter placement and selected preparation',
          'Book start did not reach its admitted owner route',
        );

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
            if (!placement) throw new Error('Book structure readback omitted the saved chapter one Post');
            expect(placement.target).toMatchObject({
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
            });
            chapterOneOccurrence = placement.occurrenceId;
            return {
              value: placement,
              observation:
                'occurrence=' +
                placement.occurrenceId +
                ' parent=' +
                placement.parentId +
                ' exact=' +
                placement.target?.revisionId,
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
            if (!part) throw new Error('Generated Book structure readback omitted part ' + partTitle);
            return { value: part, observation: 'part=' + part.occurrenceId + ' position=' + part.position };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('Book Studio part creation', 'Book start did not reach its admitted owner route');
      }

      if (book && chapterTwo) {
        chapterTwoTitle = 'The Ferry Map';
        await journal.run(
          'append the second saved draft at Book root through the mounted Root Append route',
          async () => {
            await page.goto(stack.web + '/en/studio?catalogueId=' + encodeURIComponent(catalogueId!) + '&append=1', {
              waitUntil: 'domcontentloaded',
            });
            await hydrate(page);
            await page.getByRole('heading', { name: 'Append a saved chapter', exact: true }).waitFor({
              state: 'visible',
            });
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
            if (!placement) throw new Error('Generated Book structure omitted the root-appended second Post');
            expect(placement.parentId).toBeNull();
            expect(placement.target).toMatchObject({
              revisionId: chapterTwo!.revisionId,
              sha256: chapterTwo!.sha256,
            });
            chapterTwoOccurrence = placement.occurrenceId;
            return {
              value: placement,
              observation:
                'occurrence=' +
                placement.occurrenceId +
                ' parent=' +
                placement.parentId +
                ' exact=' +
                placement.target?.revisionId,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('mounted Root Append', 'Book start or chapter two saved-version readback failed');
      }

      if (book && chapterTwo && partTitle && chapterTwoTitle && chapterTwoOccurrence) {
        await journal.run(
          'reorder the appended root chapter before its part in Book Studio',
          async () => {
            await openBookStudio(page, catalogueId!);
            await movePlacementUp(page, chapterTwoTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const moved = outline.items.find((item) => item.occurrenceId === chapterTwoOccurrence);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            if (!moved || !part || moved.parentId !== null || moved.position >= part.position)
              throw new Error('Root sibling reorder did not place the chapter before its part');
            return {
              value: moved,
              observation:
                'occurrence=' + moved.occurrenceId + ' position=' + moved.position + ' before-part=' + part.position,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('chapter reorder before nesting', 'The appended exact root chapter was not read back');
      }

      if (book && chapterTwo && partTitle && chapterTwoTitle && chapterTwoOccurrence) {
        await journal.run(
          'move the reordered exact placement into its part in Book Studio',
          async () => {
            await openBookStudio(page, catalogueId!);
            await movePlacementUnderPart(page, chapterTwoTitle!, partTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            const moved = outline.items.find((item) => item.occurrenceId === chapterTwoOccurrence);
            if (
              !part ||
              !moved ||
              moved.parentId !== part.occurrenceId ||
              moved.target?.revisionId !== chapterTwo!.revisionId ||
              moved.target.sha256 !== chapterTwo!.sha256
            )
              throw new Error('Generated structure did not retain the exact nested placement');
            return {
              value: moved,
              observation:
                'occurrence=' + moved.occurrenceId + ' parent=' + moved.parentId + ' part=' + part.occurrenceId,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('move and nest the second placement', 'The reordered root chapter or part was unavailable');
      }

      if (book && chapterOne && chapterOneOccurrence && chapterOneTitle && chapterTwo && chapterTwoOccurrence) {
        const prepared = await journal.run(
          'review, recover, and seal the exact selected private candidate',
          async () => {
            await openBookStudio(page, catalogueId!);
            const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
            const outline = await readStructure(seed!.author, catalogueId!);
            expect(owner.item.headRevisionId).toBe(outline.head.revisionId);
            expect(owner.item.publicationId).toBeNull();
            expect(outline.items.find((item) => item.occurrenceId === chapterOneOccurrence)?.target).toMatchObject({
              postId: chapterOne!.id,
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
            });
            const prepareLink = page.getByRole('link', { name: 'Prepare the whole Book', exact: true });
            const prepareHref = await prepareLink.getAttribute('href');
            if (!prepareHref) throw new Error('Book Studio did not expose the mounted preparation route');
            await prepareLink.click();
            await page.waitForURL((url) => url.searchParams.get('prepare') === '1');
            const route = new URL(page.url());
            const routeOwner = route.searchParams.get('ownerAccount');
            const routeEpoch = route.searchParams.get('ownerEpoch');
            expect(routeOwner).toBe(owner.viewer.accountId);
            expect(routeEpoch).toBe(String(owner.viewer.authnEpoch));
            await page.getByRole('heading', { name: 'Prepare a private Book release', exact: true }).waitFor({
              state: 'visible',
            });
            const reviewed = await page.locator('main').innerText();
            expect(reviewed).toContain(owner.item.headRevisionId);
            expect(reviewed).toContain('No current release');
            await page.getByRole('button', { name: 'Use these exact versions', exact: true }).click();
            await page.getByRole('button', { name: 'Choose chapters across draft pages', exact: true }).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.has('stageId'));
            stageId = new URL(page.url()).searchParams.get('stageId') ?? undefined;
            if (!stageId) throw new Error('Selected preparation did not retain its stage locator in the URL');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await hydrate(page);
            await page.getByRole('region', { name: 'Selected draft placements', exact: true }).waitFor({
              state: 'visible',
              timeout: 90_000,
            });
            expect(new URL(page.url()).searchParams.get('stageId')).toBe(stageId);
            const selection = page.getByRole('region', { name: 'Selected draft placements', exact: true });
            const selected = selection.getByRole('checkbox', { name: new RegExp(chapterOneTitle!) });
            const excluded = selection.getByRole('checkbox', { name: new RegExp(chapterTwoTitle ?? 'The Ferry Map') });
            const excludedPart = selection.getByRole('checkbox', {
              name: new RegExp(partTitle ?? 'Under the Lanterns'),
            });
            await selected.click();
            expect(await selected.isChecked()).toBe(true);
            if (await excluded.count()) expect(await excluded.isChecked()).toBe(false);
            if (await excludedPart.count()) expect(await excludedPart.isChecked()).toBe(false);
            await selection.getByRole('button', { name: 'Add checked placements from this page', exact: true }).click();
            await selection.getByRole('button', { name: 'Freeze stored selection', exact: true }).waitFor({
              state: 'visible',
            });
            const count = selection.locator('dd').nth(0);
            await count.waitFor({ state: 'visible' });
            expect(await count.innerText()).toBe('1');
            await selection.getByRole('button', { name: 'Freeze stored selection', exact: true }).click();
            await page.getByRole('button', { name: 'Resume preparation', exact: true }).waitFor({
              state: 'visible',
              timeout: 90_000,
            });
            await page.getByRole('button', { name: 'Resume preparation', exact: true }).click();
            await page.getByRole('button', { name: 'Seal private candidate', exact: true }).waitFor({
              state: 'visible',
              timeout: 120_000,
            });
            const sourceHead = owner.item.headRevisionId;
            preparationOperands =
              'catalogue=' +
              catalogueId +
              ' owner=' +
              owner.viewer.accountId +
              '@' +
              owner.viewer.authnEpoch +
              ' expectedHeadRevisionId=' +
              sourceHead +
              ' expectedPublicationId=null mode=selection stageId=' +
              stageId +
              ' selectedOccurrence=' +
              chapterOneOccurrence +
              ' targetPost=' +
              chapterOne!.id +
              ' targetThread=' +
              chapterOne!.threadId +
              ' targetRevision=' +
              chapterOne!.revisionId +
              ' targetSha256=' +
              chapterOne!.sha256 +
              ' unselectedOccurrence=' +
              (chapterTwoOccurrence ?? 'unavailable') +
              ' unselectedRevision=' +
              (chapterTwo?.revisionId ?? 'unavailable');
            await page.getByRole('button', { name: 'Seal private candidate', exact: true }).click();
            await page
              .getByText('Private candidate sealed. It has not been published. The existing release stays current.', {
                exact: true,
              })
              .waitFor({ state: 'visible', timeout: 90_000 });
            const afterSeal = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
            expect(afterSeal.item.headRevisionId).toBe(sourceHead);
            expect(afterSeal.item.publicationId).toBeNull();
            const omittedDraft = await seed!.member.posts({ id: chapterTwo!.id }).get();
            expect(omittedDraft.status).toBe(404);
            const view = await page.locator('main').innerText();
            expect(view).toMatch(/Candidate chapters\s+1/u);
            candidateSealed = true;
            return {
              value: stageId,
              observation:
                preparationOperands +
                ' candidateReady=true candidateChapters=1 currentPublication=null memberUnselectedPost=' +
                omittedDraft.status,
            };
          },
          () => pageObservation(page),
        );
        if (!prepared)
          journal.unreached(
            'selected private candidate seal',
            'The current preparation route did not acknowledge a sealed candidate',
          );
      } else {
        journal.unreached(
          'review, selected-stage recovery, and private candidate seal',
          'The selected and unselected exact chapter occurrences are required before preparation',
        );
      }

      if (
        catalogueId &&
        chapterOne &&
        chapterTwo &&
        chapterOneOccurrence &&
        chapterTwoOccurrence &&
        partTitle &&
        chapterOneTitle &&
        preparationOperands &&
        candidateSealed
      ) {
        const laterText = 'Mara revised the chart after sunrise, adding the ferry’s quiet western landing in blue ink.';
        const changed = await journal.run(
          'save a later private chapter revision after candidate sealing',
          async () => {
            const revised = await saveChapterDraft(page, seed!.author, seed!.chapterOne, laterText, false);
            return {
              value: revised.post,
              observation:
                'candidateRevision=' +
                chapterOne!.revisionId +
                ' laterPrivateRevision=' +
                revised.post.revisionId +
                ' laterSha256=' +
                revised.post.sha256,
            };
          },
          () => pageObservation(page),
        );
        if (changed) {
          await journal.run(
            'move the selected source placement after the sealed candidate',
            async () => {
              await openBookStudio(page, catalogueId!);
              await movePlacementUnderPart(page, chapterOneTitle!, partTitle!);
              const current = await readStructure(seed!.author, catalogueId!);
              const moved = current.items.find((item) => item.occurrenceId === chapterOneOccurrence);
              const currentPost = await readNativePost(seed!.author, chapterOne!.id);
              const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
              expect(moved?.parentId).toBe(
                current.items.find((item) => item.kind === 'part' && item.title === partTitle)?.occurrenceId,
              );
              expect(moved?.target).toMatchObject({
                revisionId: chapterOne!.revisionId,
                sha256: chapterOne!.sha256,
              });
              expect(currentPost.revisionId).toBe(changed.revisionId);
              expect(owner.item.headRevisionId).not.toBe(
                preparationOperands!.match(/expectedHeadRevisionId=([^ ]+)/u)?.[1],
              );
              expect(owner.item.publicationId).toBeNull();
              return {
                value: moved,
                observation:
                  'selectedOccurrence=' +
                  moved?.occurrenceId +
                  ' remainsPinned=' +
                  moved?.target?.revisionId +
                  ' laterPostHead=' +
                  currentPost.revisionId +
                  ' newDraftHead=' +
                  owner.item.headRevisionId +
                  ' currentPublication=null',
              };
            },
            () => pageObservation(page),
          );
        } else {
          journal.unreached(
            'move after later private revision and candidate source readback',
            'The later chapter version did not save',
          );
        }
        journal.unreached(
          'initial selected-candidate activation and private author reader',
          'No mounted HTTP route or KernelClient operation exposes producer activateHostedPublicationCandidate. ' +
            'The selected sealed stage remains unactivated; immutable preparation operands: ' +
            preparationOperands,
        );
        journal.unreached(
          'private author anonymous exact chapter bytes, discovery, progress, and stable old link',
          'No initial release was activated; the independent prepublished reader control below cannot satisfy this author stage. ' +
            'Immutable preparation operands: ' +
            preparationOperands,
        );
      } else {
        journal.unreached(
          'later private edit, move isolation, and initial activation boundary',
          'The selected private candidate was not sealed with recorded immutable operands',
        );
        journal.unreached(
          'private author anonymous exact chapter bytes, discovery, progress, and stable old link',
          'No mounted initial activation receipt is available',
        );
      }
    } else {
      for (const label of [
        'private saved chapter preview and revision comparison',
        'save chapter two as a separate private exact draft in Studio',
        'anonymous direct reads conceal private chapter drafts before release',
        'start Book, add and reorder chapters, create a part, and move chapters under it',
        'review, recover, and seal an exact selected private candidate',
        'later private edit and move isolation',
        'initial selected-candidate activation and private author reader',
        'private author anonymous exact chapter bytes, discovery, progress, and stable old link',
      ])
        journal.unreached(label, 'Generated private fixture setup did not complete');
    }

    await journal.finish('PRIVATE-DRAFT AUTHOR JOURNEY (initial activation separately reported)');
  },
  lifecycle,
);

nativeTest(
  'separate prepublished control exercises exact point consent, anonymous reader, Library continue, old links, and withdrawal',
  900_000,
  async () => {
    const journal = new StageJournal();
    let control: HostedReaderControl | undefined;
    let exactReaderHref: string | undefined;
    let currentReleaseRevisionId: string | undefined;
    let pointOccurrenceId: string | undefined;
    let partTitle = 'Later control contents';

    control = await journal.run('separate one-chapter prepublished control setup', async () => {
      const value = await createPrepublishedReaderControl(stack);
      return {
        value,
        observation:
          `control=catalogue:${value.catalogueId} subject:${value.subjectId}` +
          ` author=${value.authorAccountId} member=${value.memberAccountId}` +
          ` one-selected-occurrence:${value.occurrenceId} release:${value.publicationRevisionId}` +
          ` post=${value.chapter.postId} thread=${value.chapter.threadId}` +
          ` revision=${value.chapter.revisionId} sha256=${value.chapter.sha256}`,
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
    currentReleaseRevisionId = control.publicationRevisionId;

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

    const ownerJourney = await auth.signIn('alice');
    const ownerPage = pageFrom(ownerJourney);
    await ownerPage.setViewportSize({ width: 1440, height: 1000 });
    let pointRevision: Awaited<ReturnType<typeof readNativePost>> | undefined;
    const revisedText = 'A later saved version adds a westward tide mark to the harbor map.';
    const revised = await journal.run(
      'save a later private source version through mounted Studio',
      async () => {
        const result = await saveChapterDraft(ownerPage, control!.author, control!.chapter, revisedText, false);
        pointRevision = result.post;
        return {
          value: result.post,
          observation:
            'post=' +
            result.post.id +
            ' oldRevision=' +
            control!.chapter.revisionId +
            ' selectedRevision=' +
            result.post.revisionId +
            ' sha256=' +
            result.post.sha256,
        };
      },
      () => pageObservation(ownerPage),
    );

    if (revised) {
      await journal.run(
        'add the later exact source version as a separate draft occurrence',
        async () => {
          await openBookStudio(ownerPage, control!.catalogueId);
          const title = 'Control chapter · Later tide map';
          await addChapterFromPicker(ownerPage, title, control!.chapter.title);
          const outline = await readStructure(control!.author, control!.catalogueId);
          const placement = outline.items.find(
            (item) =>
              item.kind === 'chapter' && item.title === title && item.target?.revisionId === pointRevision!.revisionId,
          );
          if (!placement) throw new Error('Current Book draft omitted the exact later chapter occurrence');
          pointOccurrenceId = placement.occurrenceId;
          return {
            value: placement,
            observation:
              'occurrence=' +
              placement.occurrenceId +
              ' post=' +
              placement.target?.postId +
              ' revision=' +
              placement.target?.revisionId +
              ' sha256=' +
              placement.target?.sha256,
          };
        },
        () => pageObservation(ownerPage),
      );
    } else {
      journal.unreached(
        'add a later exact source version as a separate draft occurrence',
        'The mounted Studio source revision did not save',
      );
    }

    if (revised && pointOccurrenceId && pointRevision) {
      const pointPublication = await journal.run(
        'permit the exact private version, then publish that selected occurrence through point review',
        async () => {
          await ownerPage.goto(
            stack.web + '/en/studio?catalogueId=' + encodeURIComponent(control!.catalogueId) + '&points=1',
            { waitUntil: 'domcontentloaded' },
          );
          await hydrate(ownerPage);
          await ownerPage.getByRole('heading', { name: 'Edit this Book draft', exact: true }).waitFor({
            state: 'visible',
          });
          await ownerPage.getByRole('button', { name: 'Review one chapter for publication', exact: true }).click();
          await ownerPage
            .getByRole('heading', { name: 'Review one chapter for publication', exact: true })
            .waitFor({ state: 'visible' });
          await ownerPage.getByRole('button', { name: 'Add a public chapter', exact: true }).click();
          await ownerPage
            .getByRole('button', {
              name: 'Select saved chapter “Control chapter · Later tide map”',
              exact: true,
            })
            .click();
          await ownerPage.getByRole('button', { name: 'Reread this exact saved version', exact: true }).click();
          await ownerPage.getByText(revisedText, { exact: true }).waitFor({ state: 'visible' });
          await ownerPage.getByRole('button', { name: 'Book root', exact: true }).click();
          await ownerPage.getByRole('button', { name: 'Set public placement for the chapter', exact: true }).click();
          await ownerPage.getByRole('button', { name: 'At parent’s end', exact: true }).click();
          const previousOwner = await readOwnedBook(control!.author, control!.authorAccountId, control!.catalogueId);
          expect(previousOwner.item.publicationId).toBe(control!.publicationRevisionId);
          const previousOutline = await readStructure(control!.author, control!.catalogueId);
          expect(previousOwner.item.headRevisionId).toBe(previousOutline.head.revisionId);
          const selectedDraft = previousOutline.items.find(
            (item) => item.occurrenceId === pointOccurrenceId && item.kind === 'chapter',
          );
          expect(selectedDraft?.target).toMatchObject({
            postId: control!.chapter.postId,
            revisionId: pointRevision!.revisionId,
            sha256: pointRevision!.sha256,
          });
          const pointOperands =
            'catalogue=' +
            control!.catalogueId +
            ' owner=' +
            previousOwner.viewer.accountId +
            '@' +
            previousOwner.viewer.authnEpoch +
            ' expectedHeadRevisionId=' +
            previousOwner.item.headRevisionId +
            ' expectedPublicationId=' +
            previousOwner.item.publicationId +
            ' occurrence=' +
            pointOccurrenceId +
            ' post=' +
            control!.chapter.postId +
            ' thread=' +
            control!.chapter.threadId +
            ' revision=' +
            pointRevision!.revisionId +
            ' sha256=' +
            pointRevision!.sha256;
          await ownerPage.getByRole('button', { name: 'Review edit', exact: true }).click();
          const consent = ownerPage.getByRole('region', { name: 'Permission for this saved version', exact: true });
          await consent.getByRole('button', { name: 'Permit this version for this Book', exact: true }).waitFor({
            state: 'visible',
          });
          await consent.getByRole('button', { name: 'Permit this version for this Book', exact: true }).click();
          await consent
            .getByText(
              'Permission was granted for this saved version and this Book. This action did not publish anything.',
              { exact: true },
            )
            .waitFor({ state: 'visible', timeout: 90_000 });
          const afterPermission = await readOwnedBook(control!.author, control!.authorAccountId, control!.catalogueId);
          expect(afterPermission.item.publicationId).toBe(previousOwner.item.publicationId);
          await ownerPage.getByRole('button', { name: 'Confirm this exact publication', exact: true }).click();
          await ownerPage.getByRole('heading', { name: 'Edit acknowledged', exact: true }).waitFor({
            state: 'visible',
            timeout: 90_000,
          });
          const afterPublication = await readOwnedBook(control!.author, control!.authorAccountId, control!.catalogueId);
          if (
            !afterPublication.item.publicationId ||
            afterPublication.item.publicationId === previousOwner.item.publicationId
          )
            throw new Error('Point review did not return a new current Book release');
          const selected: JourneyPost = {
            ...control!.chapter,
            revisionId: pointRevision!.revisionId,
            sha256: pointRevision!.sha256,
            body: pointRevision!.body,
          };
          const exact = await assertPublishedBody(
            control!.anonymous,
            control!.catalogueId,
            afterPublication.item.publicationId,
            pointOccurrenceId!,
            selected,
          );
          const direct = await control!.anonymous.posts({ id: selected.postId }).get();
          expect(direct.status).toBe(404);
          currentReleaseRevisionId = afterPublication.item.publicationId;
          return {
            value: currentReleaseRevisionId,
            observation:
              pointOperands +
              ' exactRevision=' +
              selected.revisionId +
              ' sha256=' +
              exact.document?.sha256 +
              ' permissionIssuedBeforePublication=true directPost=' +
              direct.status +
              ' oldRelease=' +
              previousOwner.item.publicationId +
              ' newRelease=' +
              currentReleaseRevisionId,
          };
        },
        () => pageObservation(ownerPage),
      );
      if (!pointPublication)
        journal.unreached(
          'exact source consent and selected point publication readback',
          'The mounted point review did not acknowledge the exact selected revision',
        );
    } else {
      journal.unreached(
        'exact source consent and selected point publication readback',
        'The later source revision or its exact draft occurrence was unavailable',
      );
    }

    const memberJourney = await auth.signIn('bob');
    const memberPage = pageFrom(memberJourney);
    await memberPage.setViewportSize({ width: 1280, height: 900 });
    const discovery = await journal.run(
      'member opens the control through current Book subject discovery',
      async () => {
        const listing = await control!.member.subjects({ id: control!.subjectId }).hostedCatalogues.get({
          query: { includeTitle: '1', limit: '20' },
        });
        if (listing.status !== 200 || listing.error || !listing.data)
          throw new Error(`Generated member Book discovery returned ${listing.status}`);
        const body = listing.data as { items: { catalogueId: string; revisionId: string; title?: string }[] };
        const index = body.items.findIndex(
          (item) => item.catalogueId === control!.catalogueId && item.revisionId === currentReleaseRevisionId,
        );
        if (index < 0) throw new Error('Generated Book subject discovery omitted the separate control');
        await memberPage.goto(`${stack.web}/en/books/${encodeURIComponent(control!.subjectId)}/read?view=catalogues`, {
          waitUntil: 'domcontentloaded',
        });
        await hydrate(memberPage);
        const catalogueTitle = body.items[index]!.title?.trim() || 'Published book ' + (index + 1);
        await memberPage.getByRole('link', { name: catalogueTitle, exact: true }).click();
        await memberPage
          .getByRole('link', { name: 'Read chapter · Control chapter · Beside the harbor steps', exact: true })
          .click();
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
              publicationRevisionId: currentReleaseRevisionId,
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
          currentReleaseRevisionId!,
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
            currentReleaseRevisionId!,
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
