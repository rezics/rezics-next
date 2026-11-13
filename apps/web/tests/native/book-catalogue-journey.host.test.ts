import { expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Locator, Page } from 'playwright';
import {
  startBookCatalogueJourneyFixture,
  type BookCatalogueIdentity,
  type BookCatalogueJourneyFixture,
  type BookCatalogueType,
} from './book-catalogue-journey-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

const lifecycle = new NativeTestLifecycle('native Book catalogue journey');
let fixture: BookCatalogueJourneyFixture;

nativeBeforeAll(lifecycle, 900_000, async () => {
  fixture = await startBookCatalogueJourneyFixture();
});
nativeAfterAll(lifecycle, 240_000);

const identities = () => [fixture.subjects.book, fixture.subjects.series, fixture.subjects.edition] as const;
const types = ['schema:Book', 'schema:BookSeries', 'bf:Instance'] as const;

function stage(name: string, evidence: Record<string, unknown>): void {
  console.info('book-catalogue-journey-stage', JSON.stringify({ stage: name, ...evidence }));
}

async function pageReady(page: Page, stageName: string): Promise<void> {
  page.setDefaultTimeout(45_000);
  try {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => 'body unavailable');
    throw new Error(`${stageName}: page did not hydrate at ${page.url()}; body=${body.slice(0, 500)}`, {
      cause: error,
    });
  }
}

function exactType(address: string): string | null {
  return new URL(address).searchParams.get('type');
}

function exactSearchLink(page: Page, subject: BookCatalogueIdentity) {
  return page.locator(`a[data-slot="list-row-link"][href*="${subject.id}"]`);
}

async function assertSearchResult(page: Page, subject: BookCatalogueIdentity): Promise<void> {
  const results = page.locator('[data-search-results]');
  await browserExpect(results).toBeVisible();
  const link = exactSearchLink(page, subject);
  await browserExpect(link).toBeVisible();
  expect(await link.innerText()).toContain(subject.label);
  for (const other of identities()) {
    const count = await exactSearchLink(page, other).count();
    expect(count, `${subject.type} Search excludes ${other.type} ${other.id}`).toBe(other.id === subject.id ? 1 : 0);
  }
}

async function openLiteraryReader(page: Page, subject: BookCatalogueIdentity): Promise<string> {
  const link = exactSearchLink(page, subject);
  await browserExpect(link).toBeVisible();
  const destination = await link.getAttribute('href');
  expect(destination, `canonical Search supplied a destination for ${subject.id}`).toBeTruthy();
  await link.click();
  await page.waitForURL((url) => decodeURIComponent(url.pathname).includes(subject.id), {
    waitUntil: 'domcontentloaded',
  });
  await pageReady(page, `reader ${subject.type}`);
  const reader = page.locator('[data-slot="literary-reader"]');
  await browserExpect(reader).toBeVisible();
  await browserExpect(reader.locator(`[data-type="${subject.type}"]`)).toBeVisible();
  await browserExpect(reader.getByText(subject.label, { exact: true })).toBeVisible();
  await browserExpect(reader.getByText(subject.text, { exact: true })).toBeVisible();
  return page.url();
}

async function openNewTabFromLink(page: Page, link: Locator, label: string): Promise<Page> {
  const newPage = page.context().waitForEvent('page');
  await link.click();
  const opened = await newPage;
  await opened.waitForLoadState('domcontentloaded');
  await pageReady(opened, label);
  return opened;
}

async function assertShelfPage(page: Page, type: BookCatalogueType): Promise<void> {
  expect(new URL(page.url()).pathname).toBe('/en/library');
  expect(exactType(page.url())).toBe(type);
  await browserExpect(page.getByRole('main')).toBeVisible();
}

async function readNativeEntry(
  subjectId: string,
  persona: string,
): Promise<{ subjectId: string; state: string; revision: number }> {
  const path = `/v1/libraryEntries/${encodeURIComponent(subjectId)}?view=FULL`;
  const response = await fixture.stack.kernel(path, undefined, persona);
  const text = await response.text();
  if (response.status !== 200)
    throw new Error(`GET ${path} as ${persona} expected HTTP 200, received HTTP ${response.status}: ${text}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`GET ${path} as ${persona} returned invalid JSON: ${text.slice(0, 400)}`, { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('libraryEntry' in parsed) ||
    !parsed.libraryEntry ||
    typeof parsed.libraryEntry !== 'object'
  )
    throw new Error(`GET ${path} as ${persona} returned no Library entry`);
  const entry = parsed.libraryEntry as { subjectId?: unknown; state?: unknown; revision?: unknown };
  if (
    typeof entry.subjectId !== 'string' ||
    typeof entry.state !== 'string' ||
    typeof entry.revision !== 'number' ||
    !Number.isSafeInteger(entry.revision)
  )
    throw new Error(`GET ${path} as ${persona} returned an invalid Library entry`);
  return { subjectId: entry.subjectId, state: entry.state, revision: entry.revision };
}

nativeTest(
  'Books uses canonical Search, exact literary identities and exact-type personal Library visits',
  720_000,
  async () => {
    const { stack, auth, marker, subjects, states } = fixture;
    const alice = await auth.signIn('alice', { returnTo: '/en/books' });
    const books = alice.context.pages().at(-1)!;
    await pageReady(books, 'localized Books entry');
    expect(new URL(books.url()).pathname).toBe('/en/books');
    await browserExpect(books.locator('[data-slot="book-catalogue"]')).toBeVisible();
    stage('Books entry', { hydrated: true, url: new URL(books.url()).pathname, locale: 'en' });

    const searchForm = books.locator('form[data-slot="book-catalogue-search"]');
    await searchForm.locator('input[name="q"]').fill(marker);
    const submitted = books.context().waitForEvent('page');
    await searchForm.evaluate((form) => {
      if (!(form instanceof HTMLFormElement)) throw new Error('Books search form was not an HTML form');
      form.requestSubmit();
    });
    const formSearch = await submitted;
    await formSearch.waitForLoadState('domcontentloaded');
    await pageReady(formSearch, 'Books search handoff');
    const formSearchAddress = new URL(formSearch.url());
    expect(formSearchAddress.pathname).toBe('/en/search');
    expect(formSearchAddress.searchParams.get('q')).toBe(marker);
    expect(formSearchAddress.searchParams.get('type')).toBe('schema:Book');
    await assertSearchResult(formSearch, subjects.book);
    stage('Books search', {
      url: `${formSearchAddress.pathname}${formSearchAddress.search}`,
      type: formSearchAddress.searchParams.get('type'),
      fixtureIdentity: { id: subjects.book.id, type: subjects.book.type },
      nativeDefaultHits: fixture.search.subjects.map(({ id, type }) => ({ id, type })),
    });

    const browsePages = new Map<BookCatalogueType, Page>();
    for (const type of types) {
      const row = books.locator(`[data-book-type="${type}"]`);
      const browse = row.getByRole('link');
      await browserExpect(browse).toBeVisible();
      expect(await browse.getAttribute('target')).toBe('_blank');
      const href = await browse.getAttribute('href');
      expect(href).toBeTruthy();
      expect(exactType(new URL(href!, stack.web).href)).toBe(type);
      const browsePage = await openNewTabFromLink(books, browse, `released-type browse ${type}`);
      const browseAddress = new URL(browsePage.url());
      expect(browseAddress.pathname).toBe('/en/search');
      expect(browseAddress.searchParams.get('type')).toBe(type);
      browseAddress.searchParams.set('q', marker);
      const queryResponse = await browsePage.goto(browseAddress.href, { waitUntil: 'domcontentloaded' });
      if (queryResponse?.status() !== 200)
        throw new Error(
          `canonical Search for ${type} expected HTTP 200, received ${queryResponse?.status() ?? 'none'}`,
        );
      await pageReady(browsePage, `canonical Search for ${type}`);
      const subject =
        type === 'schema:Book' ? subjects.book : type === 'schema:BookSeries' ? subjects.series : subjects.edition;
      await assertSearchResult(browsePage, subject);
      browsePages.set(type, browsePage);
      stage('released-type Search', {
        type,
        url: `${browseAddress.pathname}${browseAddress.search}`,
        identity: { id: subject.id, type: subject.type },
        response: queryResponse.status(),
      });
    }

    const searchPages = new Map<BookCatalogueType, Page>([
      ['schema:Book', formSearch],
      ['schema:BookSeries', browsePages.get('schema:BookSeries')!],
      ['bf:Instance', browsePages.get('bf:Instance')!],
    ]);
    const readerUrls = new Map<BookCatalogueType, string>();
    for (const type of types) {
      const subject =
        type === 'schema:Book' ? subjects.book : type === 'schema:BookSeries' ? subjects.series : subjects.edition;
      const readerUrl = await openLiteraryReader(searchPages.get(type)!, subject);
      readerUrls.set(type, readerUrl);
      stage('literary reader', {
        id: subject.id,
        type: subject.type,
        url: new URL(readerUrl).pathname,
        originalText: subject.text,
      });
    }

    const bookPageShelfLinks = books.locator('[data-slot="book-catalogue-personal"] a[href*="type="]');
    expect(await bookPageShelfLinks.count()).toBe(3);
    for (const type of types) {
      const link = bookPageShelfLinks.nth(types.indexOf(type));
      const href = await link.getAttribute('href');
      expect(href).toBeTruthy();
      expect(exactType(new URL(href!, stack.web).href)).toBe(type);
      expect(await link.getAttribute('target')).toBe('_blank');
      const shelf = await openNewTabFromLink(books, link, `Books shelf handoff ${type}`);
      await assertShelfPage(shelf, type);
      if (type === 'schema:Book') {
        await browserExpect(shelf.getByRole('main')).toContainText(subjects.book.label);
        await browserExpect(shelf.getByRole('main')).toContainText(states.bookPlanned.label);
      }
      if (type === 'bf:Instance') {
        await browserExpect(shelf.getByRole('main')).toContainText(subjects.edition.label);
        await browserExpect(shelf.getByRole('main')).toContainText(states.editionPlanned.label);
      }
      if (type === 'schema:BookSeries' && states.seriesPlanned) {
        await browserExpect(shelf.getByRole('main')).toContainText(subjects.series.label);
        await browserExpect(shelf.getByRole('main')).toContainText(states.seriesPlanned.label);
      }
      stage('Books exact-type shelf', {
        type,
        address: `${new URL(shelf.url()).pathname}${new URL(shelf.url()).search}`,
      });
      await shelf.close();
    }

    const readerShelfPages = new Map<BookCatalogueType, Page>();
    for (const type of types) {
      const readerPage = searchPages.get(type)!;
      const shelfLink = readerPage.locator('[data-slot="literary-reader"] a[target="_blank"][href*="/library?"]');
      await browserExpect(shelfLink).toBeVisible();
      const href = await shelfLink.getAttribute('href');
      expect(href).toBeTruthy();
      expect(exactType(new URL(href!, stack.web).href)).toBe(type);
      const shelf = await openNewTabFromLink(readerPage, shelfLink, `reader shelf handoff ${type}`);
      const subject =
        type === 'schema:Book' ? subjects.book : type === 'schema:BookSeries' ? subjects.series : subjects.edition;
      await assertShelfPage(shelf, type);
      if (type === 'schema:Book') {
        await browserExpect(shelf.getByRole('main')).toContainText(subjects.book.label);
        await browserExpect(shelf.getByRole('main')).toContainText(states.bookPlanned.label);
      }
      if (type === 'bf:Instance') {
        await browserExpect(shelf.getByRole('main')).toContainText(subjects.edition.label);
        await browserExpect(shelf.getByRole('main')).toContainText(states.editionPlanned.label);
      }
      if (type === 'schema:BookSeries' && states.seriesPlanned) {
        await browserExpect(shelf.getByRole('main')).toContainText(subjects.series.label);
        await browserExpect(shelf.getByRole('main')).toContainText(states.seriesPlanned.label);
      }
      readerShelfPages.set(type, shelf);
      stage('reader exact-type shelf', {
        type,
        subjectId: subject.id,
        address: `${new URL(shelf.url()).pathname}${new URL(shelf.url()).search}`,
      });
    }

    const bookShelf = readerShelfPages.get('schema:Book')!;
    await browserExpect(bookShelf.getByRole('button', { name: `Actions for ${subjects.book.label}` })).toBeVisible();
    const requestStart = stack.kernelRequests().length;
    await bookShelf.getByRole('button', { name: `Actions for ${subjects.book.label}` }).click();
    await bookShelf.getByRole('menuitem', { name: 'Change status', exact: true }).click();
    const completedChoice = bookShelf.getByRole('menuitemradio', { name: states.bookCompleted.label, exact: true });
    await browserExpect(completedChoice).toBeVisible();
    await completedChoice.click();
    await browserExpect(bookShelf.getByRole('main')).toContainText(states.bookCompleted.label);
    await bookShelf.keyboard.press('Escape');
    await bookShelf.keyboard.press('Escape');
    await stack.syncKernelRequests();
    const change = stack
      .kernelRequests()
      .slice(requestStart)
      .find((request) => request.method === 'PUT' && request.url === `/v1/libraryEntries/${subjects.book.id}`);
    expect(change, 'the shelf command UI writes the exact Book entry through the native API').toBeDefined();
    const command = JSON.parse(change!.body ?? '{}') as { state?: string; revision?: number };
    expect(command).toMatchObject({ state: states.bookCompleted.id, revision: fixture.initialBookEntry.revision });

    const readback = await readNativeEntry(subjects.book.id, 'alice');
    expect(readback.subjectId).toBe(subjects.book.id);
    expect(readback.state).toBe(states.bookCompleted.id);
    expect(readback.revision).toBe(fixture.initialBookEntry.revision + 1);
    stage('Library command and independent native readback', {
      command: { method: change!.method, path: change!.url, ...command },
      readback: { subjectId: readback.subjectId, state: readback.state, revision: readback.revision },
    });

    await bookShelf.getByRole('button', { name: `Actions for ${subjects.book.label}` }).click();
    await bookShelf.getByRole('menuitem', { name: 'Open subject page', exact: true }).click();
    await bookShelf.waitForURL((url) => decodeURIComponent(url.pathname).includes(subjects.book.id), {
      waitUntil: 'domcontentloaded',
    });
    await pageReady(bookShelf, 'Library return to Book detail');
    await browserExpect(bookShelf.locator('[data-slot="literary-reader"] [data-type="schema:Book"]')).toBeVisible();
    const updatedShelfLink = bookShelf.locator('[data-slot="literary-reader"] a[target="_blank"][href*="/library?"]');
    const currentShelf = await openNewTabFromLink(bookShelf, updatedShelfLink, 'return to current Book shelf');
    await assertShelfPage(currentShelf, 'schema:Book');
    await browserExpect(currentShelf.getByRole('main')).toContainText(subjects.book.label);
    await browserExpect(currentShelf.getByRole('main')).toContainText(states.bookCompleted.label);
    await currentShelf.close();
    stage('return to current personal state', {
      book: subjects.book.id,
      exactType: 'schema:Book',
      state: states.bookCompleted,
      revision: readback.revision,
      originalBooksVisit: new URL(books.url()).pathname,
    });

    const anonymousContext = await auth.newContext('anonymous');
    const anonymousPage = await anonymousContext.newPage();
    const beforePublicRead = stack.kernelRequests().length;
    const publicResponse = await anonymousPage.goto(readerUrls.get('schema:Book')!, { waitUntil: 'domcontentloaded' });
    if (publicResponse?.status() !== 200)
      throw new Error(`anonymous public Book detail expected HTTP 200, received ${publicResponse?.status() ?? 'none'}`);
    await pageReady(anonymousPage, 'anonymous public Book detail');
    await browserExpect(anonymousPage.locator('[data-slot="literary-reader"] [data-type="schema:Book"]')).toBeVisible();
    const publicText = await anonymousPage.getByRole('main').innerText();
    expect(publicText).not.toContain(states.bookCompleted.label);
    expect(publicText).not.toContain(states.bookPlanned.label);
    await stack.syncKernelRequests();
    const anonymousPrivateReads = stack
      .kernelRequests()
      .slice(beforePublicRead)
      .filter((request) => request.method === 'GET' && request.url.startsWith('/v1/libraryEntries'));
    expect(anonymousPrivateReads, 'anonymous public reading makes no private Library entry request').toHaveLength(0);
    stage('anonymous public authorization boundary', {
      status: publicResponse.status(),
      personalStateText: 'absent',
      privateEntryReads: anonymousPrivateReads.length,
    });

    const signedOutContext = await auth.newContext('anonymous');
    const signedOutPage = await signedOutContext.newPage();
    const shelfPath = `/en/library?type=${encodeURIComponent('schema:Book')}`;
    await signedOutPage.goto(`${stack.web}${shelfPath}`, { waitUntil: 'domcontentloaded' });
    const signInAddress = new URL(signedOutPage.url());
    expect(signInAddress.pathname).toBe('/auth/sign-in');
    expect(signInAddress.searchParams.get('return_to')).toBe(shelfPath);
    stage('signed-out shelf sign-in return', { signInPath: signInAddress.pathname, returnTo: shelfPath });

    const bob = await auth.signIn('bob', { returnTo: shelfPath, context: signedOutContext });
    const bobPage = bob.context.pages().at(-1)!;
    await pageReady(bobPage, 'signed-in exact shelf return');
    expect(new URL(bobPage.url()).pathname).toBe('/en/library');
    expect(new URL(bobPage.url()).searchParams.get('type')).toBe('schema:Book');
    await browserExpect(bobPage.getByRole('main')).not.toContainText(subjects.book.label);
    await browserExpect(bobPage.getByRole('main')).not.toContainText(states.bookCompleted.label);
    stage('other-person exact shelf', {
      persona: 'bob',
      address: `${new URL(bobPage.url()).pathname}${new URL(bobPage.url()).search}`,
      aliceBookState: 'absent',
    });

    for (const type of types) {
      const page = searchPages.get(type)!;
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await pageReady(page, `Search return after ${type} reader`);
      const address = new URL(page.url());
      expect(address.pathname).toBe('/en/search');
      expect(address.searchParams.get('q')).toBe(marker);
      expect(address.searchParams.get('type')).toBe(type);
      const subject =
        type === 'schema:Book' ? subjects.book : type === 'schema:BookSeries' ? subjects.series : subjects.edition;
      await assertSearchResult(page, subject);
    }
    await browserExpect(books.locator('[data-slot="book-catalogue"]')).toBeVisible();
    expect(new URL(books.url()).pathname).toBe('/en/books');
    stage('initiating visits retained', {
      books: new URL(books.url()).pathname,
      searches: [...searchPages].map(([type, page]) => ({
        type,
        url: `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
      })),
    });
  },
  lifecycle,
);
