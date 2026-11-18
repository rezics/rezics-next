import { expect } from 'bun:test';
import type { Response } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import type { NativeAuthStack } from './auth-stack.ts';
import {
  assertShelfPage,
  bookCatalogueStage as stage,
  exactShelfRow,
  pageReady,
  problemCode,
} from './book-catalogue-browser.ts';
import { createBobBookEntry, type BookCatalogueIdentity, type NativeState } from './book-catalogue-journey-fixture.ts';
import { settledWithin } from './lifecycle.ts';
import type { NativeWebStack } from './stack.ts';

export async function assertAnonymousBookDetail(
  stack: NativeWebStack,
  auth: NativeAuthStack,
  bookReaderUrl: string,
  book: BookCatalogueIdentity,
  stateLabels: readonly string[],
): Promise<void> {
  await stack.syncKernelRequests();
  const beforePublicRead = stack.kernelRequests().length;

  const anonymousContext = await auth.newContext('anonymous');
  const anonymousPage = await anonymousContext.newPage();
  const publicResponse = await anonymousPage.goto(bookReaderUrl, { waitUntil: 'domcontentloaded' });
  if (publicResponse?.status() !== 200)
    throw new Error(`anonymous public Book detail expected HTTP 200, received ${publicResponse?.status() ?? 'none'}`);
  const documentRequest = publicResponse.request();
  const [cookies, authorization] = await Promise.all([
    documentRequest.headerValue('cookie'),
    documentRequest.headerValue('authorization'),
  ]);
  expect({ cookies: cookies !== null, bearer: authorization !== null }, 'anonymous Book document credentials').toEqual({
    cookies: false,
    bearer: false,
  });
  await pageReady(anonymousPage, 'anonymous public Book detail');
  const publicMain = anonymousPage.getByRole('main');
  await browserExpect(publicMain.getByRole('heading', { level: 1, name: book.label, exact: true })).toBeVisible();
  await browserExpect(publicMain.getByText(book.text, { exact: true })).toBeVisible();
  const publicText = await publicMain.innerText();
  for (const label of stateLabels) expect(publicText).not.toContain(label);
  await anonymousContext.close();
  await stack.syncKernelRequests();
  const anonymousPrivateReads = stack
    .kernelRequests()
    .slice(beforePublicRead)
    .filter(({ method, url }) => method === 'GET' && /^\/v1\/libraryEntries(?:[/?]|$)/u.test(url))
    .map(({ url, responseStatus, authorization }) => ({
      path: url.split('?', 1)[0],
      status: responseStatus ?? null,
      hasBearer: authorization !== null,
    }));
  stage('anonymous public authorization boundary', {
    status: publicResponse.status(),
    personalStateText: 'absent',
    privateEntryReads: anonymousPrivateReads.length,
    ...(anonymousPrivateReads.length ? { requests: anonymousPrivateReads } : {}),
  });
  expect(anonymousPrivateReads, 'anonymous public reading makes no private Library entry request').toHaveLength(0);
}

export const typedBookShelfPath = `/en/library?type=${encodeURIComponent('schema:Book')}`;

export async function assertBookShelfSignInReturn(
  stack: NativeWebStack,
  auth: NativeAuthStack,
  aliceBook: BookCatalogueIdentity,
  bookPlanned: NativeState,
): Promise<void> {
  // Keep Bob's exact Book outside the already-proven Search inventory.
  const { book: bobBook, entry: bobEntry } = await createBobBookEntry(stack, bookPlanned);
  const { accountId: bobAccountId } = await stack.authPersona('bob');
  const origin = new URL(stack.web).origin;
  const shelfPath = typedBookShelfPath;
  const shelfAddress = new URL(shelfPath, stack.web);
  const issuerOrigin = new URL(auth.origin).origin;
  const signedOutContext = await auth.newContext('anonymous');
  await stack.syncKernelRequests();
  const beforeShelfReturn = stack.kernelRequests().length;
  const browserResponses: { boundary: 'document' | 'server function'; status: number }[] = [];
  function observeResponse(response: Response) {
    const address = new URL(response.url());
    if (address.origin !== origin || browserResponses.length >= 16) return;
    if (address.href === shelfAddress.href && response.request().isNavigationRequest())
      browserResponses.push({ boundary: 'document', status: response.status() });
    else if (address.pathname.startsWith('/_serverFn/'))
      browserResponses.push({ boundary: 'server function', status: response.status() });
  }

  function observeShelfReads() {
    return stack.kernelRequests().slice(beforeShelfReturn).flatMap((request) => {
      if (request.fixtureRequest || request.method !== 'GET') return [];
      const { pathname, searchParams } = new URL(request.url, stack.kernelOrigin);
      if (pathname !== '/v1/libraryEntries') return [];
      const types = searchParams
        .getAll('type')
        .map((type) => (type === 'schema:Book' || type === 'schema:BookSeries' || type === 'bf:Instance' ? type : 'other'));
      const full = searchParams.get('view') === 'FULL';
      const firstPage = !searchParams.has('cursor') && !searchParams.has('state');
      const page20 = searchParams.get('limit') === '20';
      const defaultOrder = searchParams.get('orderBy') === 'lastActivity' && searchParams.get('direction') === 'desc';
      const exact = types.length === 1 && types[0] === 'schema:Book' && full && firstPage && page20;
      const entries = request.bookShelfEntries;
      return [
        {
          exact,
          types,
          full,
          firstPage,
          page20,
          defaultOrder,
          status: request.responseStatus ?? null,
          code: problemCode(request.failure?.body),
          bearer: request.authorization !== null,
          actor: request.access?.authenticated ? (request.access.actorId === bobAccountId ? 'bob' : 'other') : 'unobserved',
          rows: entries?.length ?? null,
          bobEntry: entries?.find(({ subjectId }) => subjectId === bobBook.id) ?? null,
          aliceEntry: entries?.some(({ subjectId }) => subjectId === aliceBook.id) ?? null,
        },
      ];
    });
  }

  let reads: ReturnType<typeof observeShelfReads> = [];
  let sampled = false;
  let phase = 'typed sign-in return';
  signedOutContext.on('response', observeResponse);
  try {
    const bob = await auth.signIn('bob', {
      context: signedOutContext,
      async openSignIn(page) {
        const response = await page
          .goto(shelfAddress.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => {
            throw new Error('The signed-out Book shelf navigation did not reach a document');
          });
        if (response?.status() !== 200)
          throw new Error(`Expected issuer login document HTTP 200, received ${response?.status() ?? 'none'}`);
        const login = response.request();
        const authorize = login.redirectedFrom();
        const signIn = authorize?.redirectedFrom();
        const shelf = signIn?.redirectedFrom();
        const loginAddress = new URL(login.url());
        const authorizeAddress = authorize && new URL(authorize.url());
        const signInAddress = signIn && new URL(signIn.url());

        // Authorization URLs carry transaction data. Assert predicates without printing their values.
        expect(shelf?.url() === shelfAddress.href && shelf.redirectedFrom() === null, 'typed shelf request').toBe(true);
        expect(signInAddress?.origin === origin && signInAddress.pathname === '/auth/sign-in', 'Web sign-in hop').toBe(
          true,
        );
        expect(signInAddress?.searchParams.getAll('return_to').length, 'Web sign-in received one return target').toBe(1);
        expect(signInAddress?.searchParams.get('return_to') === shelfPath, 'exact typed return target').toBe(true);
        expect(
          authorizeAddress?.origin === issuerOrigin &&
            authorizeAddress.pathname === '/authorize' &&
            authorizeAddress.searchParams.get('redirect_uri') === `${origin}/auth/callback`,
          'issuer authorization hop for the Web callback',
        ).toBe(true);
        expect(loginAddress.origin === issuerOrigin && loginAddress.pathname === '/login', 'issuer login hop').toBe(true);
        stage('signed-out shelf sign-in return', { signInPath: '/auth/sign-in', returnTo: shelfPath, issuerPath: '/login' });
      },
    });
    const bobPage = bob.continueOnPage();
    await auth.settlePageApp();
    expect(auth.pageAppProcess(), 'Auth UI retired after returning Bob to his shelf').toBeUndefined();
    expect(bobPage.url() === shelfAddress.href, 'callback returned to the exact typed Web shelf').toBe(true);
    await pageReady(bobPage, 'signed-in exact shelf return');
    await assertShelfPage(bobPage, 'schema:Book');
    const bobSession = await bob.context.request.get(`${issuerOrigin}/session`);
    expect(bobSession.status(), 'issuer session status').toBe(200);
    expect((await bobSession.json()).account_id === bobAccountId, 'issuer session belongs to Bob').toBe(true);
    phase = 'mounted Bob entry and Alice exclusion';
    const row = exactShelfRow(bobPage, bobBook);
    await browserExpect(row.getByRole('link', { name: bobBook.label, exact: true })).toBeVisible();
    await browserExpect(row.getByText(bookPlanned.label, { exact: true })).toBeVisible();
    await browserExpect(bobPage.getByRole('main')).not.toContainText(aliceBook.label);
    await browserExpect(exactShelfRow(bobPage, aliceBook)).toHaveCount(0);
    phase = 'native current shelf observation';
  } finally {
    signedOutContext.off('response', observeResponse);
    try {
      // The rendered row already depended on the completed response. Sample pending requests as well on failure.
      sampled = (await settledWithin(stack.sampleKernelRequests(), 5_000).catch(() => undefined)) !== undefined;
      reads = observeShelfReads();
      stage('signed-in native Book shelf', {
        phase,
        address: shelfPath,
        path: '/v1/libraryEntries',
        browserResponses,
        sampled,
        shelfReads: reads.length,
        exactReads: reads.filter(({ exact }) => exact).length,
        reads: reads.slice(0, 8),
      });
    } finally {
      await signedOutContext.close();
    }
  }

  expect(sampled, 'native request observation finished').toBe(true);
  const exactReads = reads.filter(({ exact }) => exact);
  expect(exactReads.length, 'observed native first-page FULL Book shelf reads').toBeGreaterThan(0);
  expect(exactReads.every(({ actor }) => actor === 'bob'), 'all exact Book shelf reads authenticated Bob').toBe(true);
  const successful = exactReads.filter(({ status }) => status === 200);
  expect(successful.length, 'native exact Book shelf returned HTTP 200 as Bob').toBeGreaterThan(0);
  for (const read of successful) {
    expect(read.bobEntry, 'the current native shelf contains Bob’s exact Book entry').toEqual({
      subjectId: bobBook.id,
      state: bobEntry.state,
      revision: bobEntry.revision,
    });
    expect(read.aliceEntry, 'the current native shelf excludes Alice’s exact Book entry').toBe(false);
  }
  const otherEntry = await stack.kernel(
    `/v1/libraryEntries/${encodeURIComponent(aliceBook.id)}?view=FULL`,
    undefined,
    'bob',
  );
  expect(otherEntry.status, 'Bob cannot read the Book entry owned by Alice').toBe(404);
  expect(problemCode(await otherEntry.text()), 'cross-viewer Library entry outcome').toBe('not_found');
  stage('other-person exact shelf', {
    persona: 'bob',
    address: shelfPath,
    bobBook: { subjectId: bobBook.id, state: bobEntry.state, revision: bobEntry.revision },
    aliceBookState: 'absent',
    nativeEntryStatus: otherEntry.status,
  });
}
