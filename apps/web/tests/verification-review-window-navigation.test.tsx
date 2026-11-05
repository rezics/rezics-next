import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { ReviewPage, ReadState } from '../src/account-verification/transport';

type ReviewRead = {
  viewerId: string | null;
  page: ReadState<ReviewPage>;
  operations: string[];
};
type PendingRead = { cursor?: string; resolve: (value: ReviewRead) => void };
const reads: PendingRead[] = [];
const reviewerA = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const reviewerB = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
const readReviewPage = (input: { data: { cursor?: string } }) =>
  new Promise<ReviewRead>((resolve) => reads.push({ cursor: input.data.cursor, resolve }));

mock.module('../src/account-verification/actions', () => ({
  readReviewPage,
  readAccountVerificationPage: async () => ({ viewerId: 'reviewer-a', page: { state: 'denied' } }),
  readAccountManagement: async () => ({ state: 'denied' }),
  decideVerification: async () => ({ state: 'accepted' }),
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({}) }));
afterAll(() => mock.restore());

const ready = (viewerId: string, next: string | null, requests: ReviewPage['requests'] = []): ReviewRead => ({
  viewerId,
  page: { state: 'ready', value: { requests, next } },
  operations: ['verification_request.approve', 'verification_request.reject'],
});
const unavailable = (viewerId: string): ReviewRead => ({
  viewerId,
  page: { state: 'unavailable' },
  operations: [],
});

test('review windows browse only admitted targets, retry exact failures, cap history, and retire by reader and locale', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/review/account-verifications' });
  window.scrollTo = () => {};
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: window.scrollTo.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ReviewJourney } = await import('../src/account-verification/journeys');
  const { sessionQueryKey } = await import('../src/session/browser-state');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const oldLocale = getLocale;
  overwriteGetLocale(() => 'en');
  reads.length = 0;
  const user = userEvent.setup({ document });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const setSession = (subject: string, csrfToken: string) =>
    queryClient.setQueryData(sessionQueryKey, { state: 'signed-in', subject, csrfToken });
  setSession(reviewerA, 'token-a1');
  const render = async () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ReviewJourney />
        </QueryClientProvider>,
      ),
    );
  const flush = async () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const click = async (node: HTMLElement) => act(async () => user.click(node));
  const keyClick = async (node: HTMLElement) =>
    act(async () => {
      node.focus();
      await user.keyboard('{Enter}');
    });
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const hasButton = (label: string) =>
    [...host.querySelectorAll('button')].some((node) => node.textContent?.trim() === label);
  const startRead = async (index: number) => {
    await flush();
    expect(reads).toHaveLength(index + 1);
    return reads[index]!;
  };
  const nextRead = async () => {
    const index = reads.length;
    return { index, read: await startRead(index) };
  };
  const settleRead = async (index: number, result: ReviewRead) => {
    await act(async () => {
      reads[index]!.resolve(result);
      await Promise.resolve();
    });
    await flush();
  };
  const pageRow = (name: string) =>
    ({
      request: {
        id: `request-${name}`,
        accountId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
        state: 'pending',
        statement: name,
        links: [],
        reason: null,
        problem: null,
        updatedAt: '2025-01-01T00:00:00.000Z',
        catalogueSubjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
      },
      account: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001', name, handle: null },
      subject: null,
    }) as ReviewPage['requests'][number];

  try {
    await render();
    expect((await startRead(0)).cursor).toBeUndefined();
    await settleRead(0, ready(reviewerA, 'cursor-1'));
    expect(host.textContent).toContain(m.av_empty());
    expect(hasButton(m.av_previous_page())).toBe(false);

    await keyClick(button(m.av_next_page()));
    expect((await startRead(1)).cursor).toBe('cursor-1');
    await settleRead(1, ready(reviewerA, 'cursor-2'));
    expect(document.activeElement).toBe(host.querySelector('[role="region"]'));
    expect(button(m.av_previous_page())).toBeTruthy();

    await click(button(m.av_refresh()));
    expect((await startRead(2)).cursor).toBe('cursor-1');
    await settleRead(2, ready(reviewerA, 'cursor-2'));
    await keyClick(button(m.av_previous_page()));
    expect((await startRead(3)).cursor).toBeUndefined();
    await settleRead(3, ready(reviewerA, 'cursor-1'));
    expect(document.activeElement).toBe(host.querySelector('[role="region"]'));
    expect(hasButton(m.av_previous_page())).toBe(false);

    for (let page = 1; page <= 10; page++) {
      await click(button(m.av_next_page()));
      const { index, read } = await nextRead();
      expect(read.cursor).toBe(`cursor-${page}`);
      await settleRead(index, ready(reviewerA, `cursor-${page + 1}`));
    }
    for (let previousPage = 9; previousPage >= 2; previousPage--) {
      await click(button(m.av_previous_page()));
      const { index, read } = await nextRead();
      expect(read.cursor).toBe(`cursor-${previousPage}`);
      await settleRead(index, ready(reviewerA, `cursor-${previousPage + 1}`));
    }
    expect(hasButton(m.av_previous_page())).toBe(false);

    await click(button(m.av_next_page()));
    const { index: failedIndex, read: failedRead } = await nextRead();
    expect(failedRead.cursor).toBe('cursor-3');
    await settleRead(failedIndex, unavailable(reviewerA));
    await keyClick(button(m.av_refresh()));
    const { index: retryIndex, read: retryRead } = await nextRead();
    expect(retryRead.cursor).toBe('cursor-3');
    await settleRead(retryIndex, ready(reviewerA, 'cursor-4'));
    expect(document.activeElement).toBe(host.querySelector('[role="region"]'));
    await click(button(m.av_previous_page()));
    const { index: preservedIndex, read: preservedRead } = await nextRead();
    expect(preservedRead.cursor).toBe('cursor-2');
    await settleRead(preservedIndex, ready(reviewerA, 'cursor-3'));

    await keyClick(button(m.av_next_page()));
    const { index: focusIndex, read: focusRead } = await nextRead();
    expect(focusRead.cursor).toBe('cursor-3');
    const accountsLink = host.querySelector<HTMLAnchorElement>('a[href$="/accounts"]')!;
    accountsLink.focus();
    await settleRead(focusIndex, ready(reviewerA, 'cursor-4'));
    expect(document.activeElement).toBe(accountsLink);

    await keyClick(button(m.av_first_page()));
    const { index: firstFailureIndex, read: firstFailure } = await nextRead();
    expect(firstFailure.cursor).toBeUndefined();
    await settleRead(firstFailureIndex, unavailable(reviewerA));
    await keyClick(button(m.av_refresh()));
    const { index: firstRetryIndex, read: firstRetry } = await nextRead();
    expect(firstRetry.cursor).toBeUndefined();
    await settleRead(firstRetryIndex, ready(reviewerA, 'cursor-1'));
    expect(document.activeElement).toBe(host.querySelector('[role="region"]'));
    expect(hasButton(m.av_previous_page())).toBe(false);

    await keyClick(button(m.av_next_page()));
    const { index: detachedIndex, read: detachedRead } = await nextRead();
    expect(detachedRead.cursor).toBe('cursor-1');
    await act(async () => {
      setSession(reviewerB, 'token-b');
    });
    await flush();
    const { index: replacementIndex, read: replacementRead } = await nextRead();
    expect(replacementRead.cursor).toBeUndefined();
    await settleRead(detachedIndex, ready(reviewerA, 'cursor-obsolete', [pageRow('Obsolete reader data')]));
    expect(host.textContent).not.toContain('Obsolete reader data');
    await settleRead(replacementIndex, ready(reviewerB, 'cursor-b1'));
    expect(host.textContent).not.toContain('Obsolete reader data');
    expect(hasButton(m.av_previous_page())).toBe(false);

    await act(async () => {
      setSession(reviewerA, 'token-a2');
    });
    await flush();
    const { index: returningIndex, read: returningRead } = await nextRead();
    expect(returningRead.cursor).toBeUndefined();
    await settleRead(returningIndex, ready(reviewerA, 'cursor-a1'));
    await click(button(m.av_next_page()));
    const { index: localeSourceIndex, read: localeSourceRead } = await nextRead();
    expect(localeSourceRead.cursor).toBe('cursor-a1');
    await settleRead(localeSourceIndex, ready(reviewerA, 'cursor-a2'));
    expect(button(m.av_previous_page())).toBeTruthy();
    overwriteGetLocale(() => 'fr');
    await render();
    const { index: localeIndex, read: localeRead } = await nextRead();
    expect(localeRead.cursor).toBeUndefined();
    await settleRead(localeIndex, ready(reviewerA, 'cursor-fr1'));
    expect(hasButton(m.av_previous_page())).toBe(false);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    overwriteGetLocale(oldLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
