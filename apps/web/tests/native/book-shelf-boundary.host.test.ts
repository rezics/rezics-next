import { expect } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Page, Response } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { PROBLEMS } from '../../../../services/kernel/src/http/problem-error.ts';
import { readWebTestSelectionContext } from '../../scripts/selection.ts';
import { SESSION_COOKIE } from '../../src/session/cookies.ts';
import {
  assertShelfPage,
  exactShelfRow,
  exactType,
  openNewTabFromLink,
  pageReady,
  problemCode,
} from './book-catalogue-browser.ts';
import { startBookCatalogueJourneyFixture, type BookShelfBoundaryFixture } from './book-catalogue-journey-fixture.ts';
import { assertAnonymousBookDetail, assertBookShelfSignInReturn, typedBookShelfPath } from './book-shelf-return.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';

const lifecycle = new NativeTestLifecycle('native mounted Book shelf boundary');
let fixture: BookShelfBoundaryFixture;
const evidence = resolve(import.meta.dir, '../../../../.temp/book-shelf-boundary/evidence.json');
const shelfPath = '/en/library';
const shelfReturnTest = 'Bob signs in from the typed Book shelf and sees only his own saved Book';
const selection = readWebTestSelectionContext();
const shelfReturnOnly =
  selection?.selectedFiles.length === 1 &&
  selection.selectedFiles[0] === 'tests/native/book-shelf-boundary.host.test.ts' &&
  selection.normalizedArgv.includes(`--test-name-pattern=^${shelfReturnTest}$`);

nativeBeforeAll(lifecycle, 600_000, async () => {
  fixture = await startBookCatalogueJourneyFixture(shelfReturnOnly ? 'shelf-return' : 'shelf-boundary');
});
nativeAfterAll(lifecycle, 240_000);

// Only retain known diagnostic phrases and source coordinates, never raw browser or Worker messages.
function diagnostic(text: string) {
  const kind = text.match(
    /Cannot read properties of (?:undefined|null)|is not a function|is not defined|Minified React error #\d{1,4}|Failed to fetch dynamically imported module|Failed to load resource|Hydration failed|Kernel library read failed|Library requires application reading capabilities|(?:TypeError|ReferenceError|SyntaxError|RangeError|SessionUnavailableError|PageReadError)\b/u,
  )?.[0];
  const frames = Array.from(
    text.matchAll(
      /\bsrc\/(?:library|session|settings|routes|subject|kernel|shell)\/[\w/$.-]{1,100}\.tsx?(?::\d{1,6}:\d{1,4})?/gu,
    ),
    ([frame]) => frame,
  ).slice(0, 3);
  return { kind: kind ?? 'unclassified', frames };
}

async function observeBrowser(page: Page, failed: boolean) {
  const [errors, messages, routeState, signedIn] = await Promise.all([
    failed ? page.pageErrors() : [],
    failed ? page.consoleMessages() : [],
    page
      .locator('[data-route-state]')
      .first()
      .getAttribute('data-route-state', { timeout: 500 })
      .catch(() => null),
    page.locator('#account-menu-button').isVisible(),
  ]);
  return {
    routeState: ['closed', 'error', 'missing', 'unavailable'].includes(routeState ?? '') ? routeState : null,
    session: signedIn
      ? 'signed-in'
      : new URL(page.url()).pathname === '/auth/sign-in'
        ? 'sign-in-redirect'
        : 'unconfirmed',
    pageErrors: errors.slice(0, 6).map((error) => diagnostic(`${error.message}\n${error.stack ?? ''}`)),
    console: messages
      .filter((message) => message.type() === 'error' || message.type() === 'warning')
      .slice(0, 8)
      .map((message) => ({ level: message.type(), ...diagnostic(`${message.text()}\n${message.location().url}`) })),
  };
}

nativeTest(
  'Alice opens the exact planned Book from the Books shelf link',
  300_000,
  async () => {
    const { stack, auth, book, bookPlanned, nativeShelf } = fixture;
    const alice = await auth.signIn('alice', { returnTo: '/en/books' });
    const signInStatus = (await alice.response()).status();
    const books = alice.continueOnPage();
    await auth.settlePageApp();
    expect(auth.pageAppProcess()).toBeUndefined();
    const origin = new URL(stack.web).origin;
    await browserExpect(books.locator('[data-slot="book-catalogue"]')).toBeVisible();
    expect(new URL(books.url()).origin).toBe(origin);
    expect(new URL(books.url()).pathname).toBe('/en/books');

    const { accountId } = await stack.authPersona('alice');
    await stack.syncKernelRequests();
    const kernelStart = stack.kernelRequests().length;
    const outputStart = stack.webOutput();
    const browserContext = books.context();
    let shelf: Page | undefined;
    let shelfDocument: Response | undefined;
    const browserResponses: { boundary: 'document' | 'server function'; status: number }[] = [];
    function observeResponse(response: Response) {
      const address = new URL(response.url());
      if (address.origin !== origin || browserResponses.length >= 16) return;
      // Context-level observation sees the initial document response before Playwright exposes the popup.
      if (
        address.pathname === shelfPath &&
        exactType(address.href) === book.type &&
        response.request().isNavigationRequest()
      ) {
        shelfDocument ??= response;
        browserResponses.push({ boundary: 'document', status: response.status() });
      } else if (address.pathname.startsWith('/_serverFn/') && shelf && response.frame().page() === shelf) {
        browserResponses.push({ boundary: 'server function', status: response.status() });
      }
    }
    browserContext.on('response', observeResponse);
    let phase = 'checking first Books shelf link';
    let passed = false;
    try {
      const link = books.locator('[data-slot="book-catalogue-personal"] a[href*="type="]').first();
      await browserExpect(link).toBeVisible();
      expect(await link.getAttribute('target')).toBe('_blank');
      const href = new URL((await link.getAttribute('href'))!, origin);
      expect({ origin: href.origin, path: href.pathname, type: exactType(href.href) }).toEqual({
        origin,
        path: shelfPath,
        type: book.type,
      });
      phase = 'opening shelf popup';
      shelf = await openNewTabFromLink(books, link, 'Books shelf handoff schema:Book', (popup) => (shelf = popup));
      phase = 'checking mounted shelf';
      await assertShelfPage(shelf, book.type);
      expect(new URL(shelf.url()).origin).toBe(origin);
      phase = 'checking exact planned Book';
      const row = exactShelfRow(shelf, book);
      await browserExpect(row.getByRole('link', { name: book.label, exact: true })).toBeVisible();
      await browserExpect(row.getByText(bookPlanned.label, { exact: true })).toBeVisible();
      await browserExpect(books.locator('[data-slot="book-catalogue"]')).toBeVisible();
      phase = 'checking SSR and mounted native request';
      expect(browserResponses.some(({ boundary, status }) => boundary === 'document' && status === 200)).toBe(true);
      passed = true;
    } catch {
      // The bounded record below replaces the browser exception, which can embed raw URLs and page text.
    } finally {
      const kernelFlushed =
        (await settledWithin(
          stack.syncKernelRequests().then(() => true),
          5_000,
        ).catch(() => false)) === true;
      const kernel = stack
        .kernelRequests()
        .slice(kernelStart)
        .flatMap((request) => {
          if (request.fixtureRequest || request.method !== 'GET') return [];
          const { pathname, searchParams } = new URL(request.url, stack.kernelOrigin);
          const route =
            pathname === `/v1/accounts/${encodeURIComponent(accountId)}/preferences` ? 'account preferences' : pathname;
          if (
            ![
              'account preferences',
              '/v1/libraryEntries',
              '/v1/libraryContinue',
              '/v1/libraryPins',
              '/v1/collections',
              '/v1/openapi.json',
              '/v1/platform/exposure',
              '/v1/definitions/active',
            ].includes(route)
          )
            return [];
          const code = problemCode(request.failure?.body);
          return [
            {
              route,
              status: request.responseStatus ?? null,
              code: code && Object.hasOwn(PROBLEMS, code) ? code : null,
              bearer: request.authorization !== null,
              alice: request.access ? request.access.actorId === accountId : null,
              exactShelf:
                route === '/v1/libraryEntries' &&
                searchParams.get('type') === book.type &&
                searchParams.get('view') === 'FULL' &&
                searchParams.get('limit') === '20' &&
                searchParams.get('orderBy') === 'lastActivity' &&
                searchParams.get('direction') === 'desc',
            },
          ];
        });
      passed &&= kernelFlushed && kernel.some(({ exactShelf, status, alice }) => exactShelf && status === 200 && alice);
      const [browser, sessionCookieSent] = await Promise.all([
        shelf ? settledWithin(observeBrowser(shelf, !passed), 2_000).catch(() => undefined) : undefined,
        shelfDocument
          ? settledWithin(
              shelfDocument
                .request()
                .headerValue('cookie')
                .then(
                  (header) =>
                    header?.split(';').some((value) => value.trimStart().startsWith(`${SESSION_COOKIE}=`)) ?? false,
                ),
              2_000,
            ).catch(() => undefined)
          : undefined,
      ]);
      browserContext.off('response', observeResponse);
      const output = stack.webOutput();
      const workerDiagnostics = output
        .slice(output.startsWith(outputStart) ? outputStart.length : 0)
        .split('\n')
        .map(diagnostic)
        .filter(({ kind, frames }) => kind !== 'unclassified' || frames.length)
        .slice(-8);
      await mkdir(dirname(evidence), { recursive: true, mode: 0o700 });
      await writeFile(
        evidence,
        JSON.stringify(
          {
            outcome: passed ? 'pass' : 'fail',
            phase,
            book: { id: book.id, type: book.type },
            nativeShelf,
            signInStatus,
            sessionCookieSent: sessionCookieSent ?? null,
            browserResponses,
            browser: browser ?? null,
            kernelFlushed,
            kernel: kernel.slice(0, 20),
            workerDiagnostics,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    }
    if (!passed)
      throw new Error(`Mounted Book shelf proof failed while ${phase}. See .temp/book-shelf-boundary/evidence.json`);
  },
  lifecycle,
);

if (shelfReturnOnly) {
  nativeTest(
    shelfReturnTest,
    720_000,
    async () => {
      const { stack, auth, book, bookPlanned } = fixture;
      const alice = await auth.signIn('alice', { returnTo: typedBookShelfPath });
      const alicePage = alice.continueOnPage();
      await auth.settlePageApp();
      expect(auth.pageAppProcess(), 'Auth UI retired after returning Alice to her shelf').toBeUndefined();
      await pageReady(alicePage, 'Alice’s exact Book shelf');
      await assertShelfPage(alicePage, 'schema:Book');
      const row = exactShelfRow(alicePage, book);
      const link = row.getByRole('link', { name: book.label, exact: true });
      await browserExpect(link).toBeVisible();
      await browserExpect(row.getByText(bookPlanned.label, { exact: true })).toBeVisible();
      const href = await link.getAttribute('href');
      if (!href) throw new Error('Alice’s exact Book shelf row did not link to the public Book');
      await alice.context.close();

      await assertAnonymousBookDetail(stack, auth, new URL(href, stack.web).href, book, [bookPlanned.label]);
      await assertBookShelfSignInReturn(stack, auth, book, bookPlanned);
    },
    lifecycle,
  );
}
