import { expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page, Response } from 'playwright';
import { resolve } from 'node:path';
import { parseLegacySearchPage } from '../../src/search/discovery.ts';
import {
  startBookCatalogueJourneyFixture,
  type BookCatalogueIdentity,
  type BookCatalogueJourneyFixture,
  type BookCatalogueType,
} from './book-catalogue-journey-fixture.ts';
import {
  assertShelfPage,
  exactShelfRow,
  exactType,
  openNewTabFromLink,
  pageReady,
  problemCode,
} from './book-catalogue-browser.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
import { sampleNativeMemory, sampleOwnedWebRunMemory } from './native-memory.ts';
import {
  bookFailure,
  completeBookCatalogueAcceptance,
  writeBookCatalogueVerdicts,
  type BookCatalogueVerdicts,
} from './book-catalogue-acceptance.ts';

const lifecycle = new NativeTestLifecycle('native Book catalogue journey');
let fixture: BookCatalogueJourneyFixture;
let coldFailure: Error | undefined;
const verdicts: BookCatalogueVerdicts = {
  coldSearch: { outcome: 'unreached' },
  ui: { outcome: 'unreached' },
};
const verdictPath = resolve(import.meta.dir, '../../../../.temp/book-catalogue-journey/verdicts.json');
const persistVerdicts = () => writeBookCatalogueVerdicts(verdictPath, verdicts);

nativeBeforeAll(lifecycle, 600_000, async (signal) => {
  const setupDeadline = Date.now() + 600_000;
  await persistVerdicts();
  try {
    fixture = await startBookCatalogueJourneyFixture({
      setupDeadline,
      signal,
      async recordColdSearch(verdict) {
        if (verdict.outcome === 'failed') {
          coldFailure = verdict.error instanceof Error ? verdict.error : new Error(bookFailure(verdict.error));
          verdicts.coldSearch = { outcome: 'failed', failure: bookFailure(verdict.error) };
        } else verdicts.coldSearch = { outcome: verdict.outcome };
        await persistVerdicts();
      },
    });
  } catch (error) {
    verdicts.ui = { outcome: 'unreached' };
    verdicts.setupFailure = bookFailure(error);
    await persistVerdicts();
    if (coldFailure)
      throw new AggregateError(
        error === coldFailure ? [coldFailure] : [coldFailure, error],
        'Required Book catalogue setup failed',
      );
    throw error;
  }
});
nativeAfterAll(lifecycle, 240_000);

const identities = () => [fixture.subjects.book, fixture.subjects.series, fixture.subjects.edition] as const;
const types = ['schema:Book', 'schema:BookSeries', 'bf:Instance'] as const;

function stage(name: string, evidence: Record<string, unknown>): void {
  console.info('book-catalogue-journey-stage', JSON.stringify({ stage: name, ...evidence }));
}

function readerMemory(stageName: string, page: Page): void {
  if (process.env.NATIVE_WEB_BOOK_MEMORY !== '1') return;
  const browser = fixture.auth.browserMemoryObservation();
  const { sampledAt, cgroup } = sampleNativeMemory([]);
  stage(stageName, {
    pages: page.context().pages().length,
    browser,
    sampledAt,
    command: cgroup.command,
    run: sampleOwnedWebRunMemory('other'),
  });
}

function exactSearchLink(page: Page, subject: BookCatalogueIdentity) {
  return page.locator(`#search-results a[data-slot="list-row-link"][href*="${subject.id}"]`);
}

async function assertSearchResult(page: Page, subject: BookCatalogueIdentity): Promise<void> {
  const results = page.locator('#search-results');
  await browserExpect(results).toBeVisible();
  const expected = identities();
  await browserExpect(async () => {
    // Hydration can replace the current result list. Match and exclude identities in one rendered snapshot.
    const rendered = await results.locator('a[data-slot="list-row-link"]').evaluateAll(
      (links, ids) =>
        ids.map((id) =>
          links
            .filter((link) => link.getAttribute('href')?.includes(id))
            .map((link) => ({
              text: (link as HTMLElement).innerText,
              visible: link.getClientRects().length > 0 && getComputedStyle(link).visibility === 'visible',
            })),
        ),
      expected.map(({ id }) => id),
    );
    for (const [index, other] of expected.entries()) {
      const matching = rendered[index]!;
      if (other.id === subject.id) {
        expect(matching, `exact result for ${subject.type}`).toHaveLength(1);
        expect(matching[0]).toMatchObject({ visible: true, text: expect.stringContaining(subject.label) });
      } else {
        expect(matching, `${subject.type} Search excludes ${other.type} ${other.id}`).toHaveLength(0);
      }
    }
  }).toPass({ timeout: 5_000 });
}

async function reportBookSearchFailure(
  browserResponses: readonly { boundary: 'document' | 'server function'; status: number }[],
) {
  const { stack, marker, subjects } = fixture;
  await stack.syncKernelRequests();
  const kernelRequests = stack
    .kernelRequests()
    .filter((request) => !request.fixtureRequest && request.method === 'POST' && request.url === '/v1/subjects:search');
  const browserToKernel = kernelRequests.slice(-6).map((request) => ({
    status: request.responseStatus ?? null,
    hasBearer: request.authorization !== null,
    code: problemCode(request.failure?.body),
  }));
  stage('Books search transport', { browserResponses, browserToKernel });
  const control = await stack.kernel('/v1/subjects:search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: { type: { in: [subjects.book.type] } },
      languages: ['en'],
      descriptions: true,
      limit: 20,
      text: marker,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const body: unknown = await control.json().catch(() => undefined);
  const page = parseLegacySearchPage(body);
  stage('Books search exact typed Kernel control', {
    status: control.status,
    code: problemCode(body),
    parsed: page !== undefined,
    expectedBook: page?.subjects.some(({ id, type }) => id === subjects.book.id && type === subjects.book.type),
  });
}

async function assertPlannedShelf(shelf: Page, type: BookCatalogueType): Promise<void> {
  const { subjects, states } = fixture;
  await assertShelfPage(shelf, type);
  const subject = type === 'schema:Book' ? subjects.book : type === 'bf:Instance' ? subjects.edition : subjects.series;
  const state =
    type === 'schema:Book' ? states.bookPlanned : type === 'bf:Instance' ? states.editionPlanned : states.seriesPlanned;
  if (state) {
    const row = exactShelfRow(shelf, subject);
    await browserExpect(row.getByRole('link', { name: subject.label, exact: true })).toBeVisible();
    await browserExpect(row.getByText(state.label, { exact: true })).toBeVisible();
  }
}

async function openReaderShelf(page: Page, subject: BookCatalogueIdentity, observeClick = false) {
  const link = exactSearchLink(page, subject);
  await browserExpect(link).toBeVisible();
  const destination = await link.getAttribute('href');
  expect(destination, `canonical Search supplied a destination for ${subject.id}`).toBeTruthy();
  const searchUrl = page.url();
  let searchDocuments = 0;
  const observeDocument = (response: Response) => {
    if (response.request().isNavigationRequest() && response.url() === searchUrl) searchDocuments++;
  };
  if (observeClick) page.on('response', observeDocument);
  const witness = observeClick
    ? await settledWithin(watchBookResult(page, destination!), 1_000).catch(() => undefined)
    : undefined;
  let clicked = false;
  try {
    await link.click();
    clicked = true;
  } finally {
    if (observeClick) page.off('response', observeDocument);
    const dom =
      witness &&
      (await settledWithin(
        witness.evaluate((stop) => stop()),
        1_000,
      ).catch(() => undefined));
    void witness?.dispose().catch(() => {});
    if (observeClick && !clicked) {
      const { stack } = fixture;
      const reader = await settledWithin(
        stack.syncKernelRequests().then(() =>
          stack
            .kernelRequests()
            .filter(
              (request) =>
                !request.fixtureRequest &&
                request.method === 'GET' &&
                request.url.split('?')[0] === `/v1/subjects/${subject.id}`,
            )
            .slice(-4)
            .map((request) => ({
              status: request.responseStatus ?? 'pending',
              code: problemCode(request.failure?.body),
            })),
        ),
        2_000,
      ).catch(() => undefined);
      stage('Book Search pointer', {
        dom: dom ?? 'observation unavailable',
        searchDocuments,
        reader: reader ?? 'observation unavailable',
      });
    }
  }
  await page.waitForURL((url) => decodeURIComponent(url.pathname).includes(subject.id), {
    waitUntil: 'domcontentloaded',
  });
  await pageReady(page, `reader ${subject.type}`);
  const reader = page.getByRole('main');
  await browserExpect(reader.locator('[data-slot="literary-overview-destinations"]')).toBeVisible();
  await browserExpect(reader.getByRole('heading', { level: 1, name: subject.label, exact: true })).toBeVisible();
  await browserExpect(reader.getByText(subject.text, { exact: true })).toBeVisible();
  const shelfDestination = reader.locator('[data-slot="literary-overview-destinations"] a[href*="/library?"]');
  expect(exactType(new URL((await shelfDestination.getAttribute('href'))!, fixture.stack.web).href)).toBe(subject.type);
  const readerUrl = page.url();
  const { type } = subject;
  stage('literary reader', {
    id: subject.id,
    type,
    url: new URL(readerUrl).pathname,
    originalText: subject.text,
  });

  const shelfLink = page.locator('[data-slot="literary-overview-destinations"] a[target="_blank"][href*="/library?"]');
  await browserExpect(shelfLink).toBeVisible();
  const href = await shelfLink.getAttribute('href');
  expect(href).toBeTruthy();
  expect(exactType(new URL(href!, fixture.stack.web).href)).toBe(type);
  readerMemory('before reader Library popup', page);
  const shelf = await openNewTabFromLink(page, shelfLink, `reader shelf handoff ${type}`, (popup) =>
    readerMemory('reader Library popup opened', popup),
  );
  readerMemory('reader Library popup hydrated', shelf);
  await assertPlannedShelf(shelf, type);
  stage('reader exact-type shelf', {
    type,
    subjectId: subject.id,
    address: `${new URL(shelf.url()).pathname}${new URL(shelf.url()).search}`,
  });
  return { readerUrl, shelf };
}

function watchBookResult(page: Page, href: string) {
  return page.evaluateHandle((href) => {
    const selector = `#search-results a[data-slot="list-row-link"][href=${CSS.escape(href)}]`;
    const report = {
      replacements: 0,
      detachments: 0,
      frames: 0,
      missingFrames: 0,
      layoutChanges: 0,
      longestStableRun: 0,
    };
    let current: Element | null = null;
    let previous: Element | null = null;
    let box: number[] | undefined;
    let stableRun = 0;
    let frameId: number;
    const observe = () => {
      const next = document.querySelector(selector);
      if (next === current) return;
      if (current && !current.isConnected) report.detachments++;
      if (next && previous && next !== previous) report.replacements++;
      if (next) previous = next;
      current = next;
      box = undefined;
      stableRun = 0;
    };
    const sample = () => {
      observe();
      report.frames++;
      if (current) {
        const { x, y, width, height } = current.getBoundingClientRect();
        const next = [x, y, width, height];
        const unchanged = box && next.every((value, index) => value === box![index]);
        if (box && !unchanged) report.layoutChanges++;
        stableRun = width && height ? (unchanged ? stableRun + 1 : 1) : 0;
        report.longestStableRun = Math.max(report.longestStableRun, stableRun);
        box = next;
      } else report.missingFrames++;
      frameId = requestAnimationFrame(sample);
    };
    const observer = new MutationObserver(observe);
    observe();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    frameId = requestAnimationFrame(sample);
    const stop = () => {
      clearTimeout(deadline);
      observer.disconnect();
      cancelAnimationFrame(frameId);
      return { ...report, visibility: document.visibilityState, focused: document.hasFocus() };
    };
    const deadline = window.setTimeout(stop, 45_000);
    return stop;
  }, href);
}

async function returnToSearch(page: Page, subject: BookCatalogueIdentity, marker: string) {
  const { type } = subject;
  await page.goBack({ waitUntil: 'domcontentloaded' });
  if (type === 'schema:Book') readerMemory('reader Back arrived at Search', page);
  await pageReady(page, `Search return after ${type} reader`);
  const address = new URL(page.url());
  expect(address.pathname).toBe('/en/search');
  expect(address.searchParams.get('q')).toBe(marker);
  expect(address.searchParams.get('type')).toBe(type);
  await assertSearchResult(page, subject);
  if (type === 'schema:Book') readerMemory('reader Back restored typed Search', page);
  return { type, url: `${address.pathname}${address.search}` };
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

async function runBookCatalogueJourney(): Promise<void> {
  const { stack, auth, marker, subjects, states } = fixture;
  const alice = await auth.signIn('alice', { returnTo: '/en/books' });
  const books = alice.continueOnPage();
  await pageReady(books, 'localized Books entry');
  expect(new URL(books.url()).pathname).toBe('/en/books');
  await browserExpect(books.locator('[data-slot="book-catalogue"]')).toBeVisible();
  stage('Books entry', { hydrated: true, url: new URL(books.url()).pathname, locale: 'en' });

  const bookPageShelfLinks = books.locator('[data-slot="book-catalogue-personal"] a[href*="type="]');
  expect(await bookPageShelfLinks.count()).toBe(3);
  for (const type of types) {
    const link = bookPageShelfLinks.nth(types.indexOf(type));
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();
    expect(exactType(new URL(href!, stack.web).href)).toBe(type);
    expect(await link.getAttribute('target')).toBe('_blank');
    const shelf = await openNewTabFromLink(books, link, `Books shelf handoff ${type}`);
    await assertPlannedShelf(shelf, type);
    stage('Books exact-type shelf', {
      type,
      address: `${new URL(shelf.url()).pathname}${new URL(shelf.url()).search}`,
    });
    await shelf.close();
  }

  const searchForm = books.locator('form[data-slot="book-catalogue-search"]');
  await searchForm.locator('input[name="q"]').fill(marker);
  const origin = new URL(stack.web).origin;
  const browserResponses: { boundary: 'document' | 'server function'; status: number }[] = [];
  const observeSearchResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || browserResponses.length >= 12) return;
    if (url.pathname === '/en/search' && response.request().isNavigationRequest())
      browserResponses.push({ boundary: 'document', status: response.status() });
    else if (url.pathname.startsWith('/_serverFn/'))
      browserResponses.push({ boundary: 'server function', status: response.status() });
  };
  let formSearch: Page;
  books.context().on('response', observeSearchResponse);
  try {
    const submitted = books.context().waitForEvent('page');
    await searchForm.evaluate((form) => {
      if (!(form instanceof HTMLFormElement)) throw new Error('Books search form was not an HTML form');
      form.requestSubmit();
    });
    formSearch = await submitted;
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
  } catch (error) {
    await reportBookSearchFailure(browserResponses).catch((diagnosticError) =>
      stage('Books search diagnostic', {
        error: diagnosticError instanceof Error ? diagnosticError.name : 'unknown',
      }),
    );
    throw error;
  } finally {
    books.context().off('response', observeSearchResponse);
  }

  // Keep the Book's Library popup for the write after checking Back on its Search tab.
  const { readerUrl: bookReaderUrl, shelf: bookShelf } = await openReaderShelf(formSearch, subjects.book, true);
  const searches = [await returnToSearch(formSearch, subjects.book, marker)];
  await formSearch.close();

  await browserExpect(bookShelf.getByRole('button', { name: `Actions for ${subjects.book.label}` })).toBeVisible();
  const requestStart = stack.kernelRequests().length;
  await bookShelf.getByRole('button', { name: `Actions for ${subjects.book.label}` }).click();
  await bookShelf.getByRole('menuitem', { name: 'Change status', exact: true }).click();
  const completedChoice = bookShelf.getByRole('menuitemradio', { name: states.bookCompleted.label, exact: true });
  await browserExpect(completedChoice).toBeVisible();
  await completedChoice.click();
  await browserExpect(
    exactShelfRow(bookShelf, subjects.book).getByText(states.bookCompleted.label, { exact: true }),
  ).toBeVisible();
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
  await browserExpect(
    bookShelf.getByRole('heading', { level: 1, name: subjects.book.label, exact: true }),
  ).toBeVisible();
  const updatedShelfLink = bookShelf.locator(
    '[data-slot="literary-overview-destinations"] a[target="_blank"][href*="/library?"]',
  );
  const currentShelf = await openNewTabFromLink(bookShelf, updatedShelfLink, 'return to current Book shelf');
  await assertShelfPage(currentShelf, 'schema:Book');
  const currentRow = exactShelfRow(currentShelf, subjects.book);
  await browserExpect(currentRow.getByRole('link', { name: subjects.book.label, exact: true })).toBeVisible();
  await browserExpect(currentRow.getByText(states.bookCompleted.label, { exact: true })).toBeVisible();
  await currentShelf.close();
  stage('return to current personal state', {
    book: subjects.book.id,
    exactType: 'schema:Book',
    state: states.bookCompleted,
    revision: readback.revision,
    originalBooksVisit: new URL(books.url()).pathname,
  });
  await bookShelf.close();

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
      throw new Error(`canonical Search for ${type} expected HTTP 200, received ${queryResponse?.status() ?? 'none'}`);
    await pageReady(browsePage, `canonical Search for ${type}`);
    const subject =
      type === 'schema:Book' ? subjects.book : type === 'schema:BookSeries' ? subjects.series : subjects.edition;
    await assertSearchResult(browsePage, subject);
    stage('released-type Search', {
      type,
      url: `${browseAddress.pathname}${browseAddress.search}`,
      identity: { id: subject.id, type: subject.type },
      response: queryResponse.status(),
    });
    if (type !== 'schema:Book') {
      const { shelf } = await openReaderShelf(browsePage, subject);
      await shelf.close();
      searches.push(await returnToSearch(browsePage, subject, marker));
    }
    await browsePage.close();
  }

  await browserExpect(books.locator('[data-slot="book-catalogue"]')).toBeVisible();
  expect(new URL(books.url()).pathname).toBe('/en/books');
  stage('initiating visits retained', {
    books: new URL(books.url()).pathname,
    searches,
  });
  await books.close();

  const anonymousContext = await auth.newContext('anonymous');
  const anonymousPage = await anonymousContext.newPage();
  const beforePublicRead = stack.kernelRequests().length;
  const publicResponse = await anonymousPage.goto(bookReaderUrl, { waitUntil: 'domcontentloaded' });
  if (publicResponse?.status() !== 200)
    throw new Error(`anonymous public Book detail expected HTTP 200, received ${publicResponse?.status() ?? 'none'}`);
  await pageReady(anonymousPage, 'anonymous public Book detail');
  await browserExpect(
    anonymousPage.getByRole('heading', { level: 1, name: subjects.book.label, exact: true }),
  ).toBeVisible();
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
  await anonymousContext.close();

  const signedOutContext = await auth.newContext('anonymous');
  const signedOutPage = await signedOutContext.newPage();
  const shelfPath = `/en/library?type=${encodeURIComponent('schema:Book')}`;
  await signedOutPage.goto(`${stack.web}${shelfPath}`, { waitUntil: 'domcontentloaded' });
  const signInAddress = new URL(signedOutPage.url());
  expect(signInAddress.pathname).toBe('/auth/sign-in');
  expect(signInAddress.searchParams.get('return_to')).toBe(shelfPath);
  stage('signed-out shelf sign-in return', { signInPath: signInAddress.pathname, returnTo: shelfPath });

  await signedOutPage.close();
  const bob = await auth.signIn('bob', { returnTo: shelfPath, context: signedOutContext });
  const bobPage = bob.continueOnPage();
  await pageReady(bobPage, 'signed-in exact shelf return');
  expect(new URL(bobPage.url()).pathname).toBe('/en/library');
  expect(new URL(bobPage.url()).searchParams.get('type')).toBe('schema:Book');
  await browserExpect(bobPage.getByRole('main')).not.toContainText(subjects.book.label);
  await browserExpect(exactShelfRow(bobPage, subjects.book)).toHaveCount(0);
  stage('other-person exact shelf', {
    persona: 'bob',
    address: `${new URL(bobPage.url()).pathname}${new URL(bobPage.url()).search}`,
    aliceBookState: 'absent',
  });
  await signedOutContext.close();
}

nativeTest(
  'Books uses canonical Search, exact literary identities and exact-type personal Library visits',
  720_000,
  async () => {
    verdicts.ui = { outcome: 'running' };
    await persistVerdicts();
    await completeBookCatalogueAcceptance(coldFailure, runBookCatalogueJourney, async (verdict) => {
      verdicts.ui = verdict;
      await persistVerdicts();
    });
  },
  lifecycle,
);
