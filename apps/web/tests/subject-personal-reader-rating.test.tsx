import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, createElement, useState } from 'react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { SubjectOwnRating, RatingQuestion } from '../src/features/pages/subject-ratings';
import type { SubjectPersonalReadTransport, SubjectReaderObservation } from '../src/features/pages/subject-queries';
import type { RatingWrite } from '../src/features/pages/rating-control';

// UNRUN: one mounted journey over the real QueryClient, session observer, personal query factories,
// retirement adapter and optimistic rating control. Only the prepared read/write BFF boundaries are deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/reader/overview', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, useQueryClient } = await import('@tanstack/react-query');
const { useSession } = await import('../src/session/query');
const { useSubjectPersonalReader } = await import('../src/features/pages/subject-personal-reader');
const { applyOptimisticRatingChange, SubjectRatingControl } = await import('../src/features/pages/rating-control');
const { subjectOwnRatingQuery, subjectReaderQuery } = await import('../src/features/pages/subject-queries');
const { preparedRatingReader, QUESTION, readOwnRating } = await import('../src/features/pages/subject-ratings');
const { writeSubjectRatingForCurrentReader } = await import('../src/features/pages/rating-actions');

const subjectA = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const subjectB = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const question: RatingQuestion = {
  id: QUESTION,
  revision: 1,
  label: 'Your rating',
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 4 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Session = { state: 'signed-in' | 'signed-out'; csrfToken: string | null; subject: string | null };
type Page = { subjectId: string; locale: string; view: string };
type ReaderCall = ReturnType<typeof deferred<SubjectReaderObservation>> & {
  subjectId: string;
  locale: string;
  actualReader: string | null;
};
type RatingCall = ReturnType<typeof deferred<SubjectOwnRating>> & {
  subjectId: string;
  locale: string;
  actualReader: string | null;
  expectedReader: string | null;
};
type WriteCall = ReturnType<typeof deferred<boolean>> & {
  units: number | null;
  idempotencyKey: string;
  expectedReader: string;
};

type Harness = {
  client: QueryClient;
  readers: ReaderCall[];
  ratings: RatingCall[];
  writes: WriteCall[];
  readTransport: SubjectPersonalReadTransport;
  write: RatingWrite;
  host: HTMLElement;
  page: Page;
  observers: number;
  render(nextPage?: Page, observers?: number): Promise<void>;
  setSession(session: Session): Promise<void>;
  flush(): Promise<void>;
  unmount(): Promise<void>;
  remount(): Promise<void>;
};

function makeHarness(initialSession: Session, initialPage: Page, observerCount = 1): Harness {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['session'], initialSession);
  const readers: ReaderCall[] = [];
  const ratings: RatingCall[] = [];
  const writes: WriteCall[] = [];
  const readTransport: SubjectPersonalReadTransport = {
    readReader: ({ id, locale }) => {
      const actualReader = client.getQueryData<Session>(['session'])?.subject ?? null;
      const call = { ...deferred<SubjectReaderObservation>(), subjectId: id, locale, actualReader };
      readers.push(call);
      return call.promise;
    },
    readOwnRating: ({ id, locale, expectedReader }) => {
      const actualReader = client.getQueryData<Session>(['session'])?.subject ?? null;
      const call = { ...deferred<SubjectOwnRating>(), subjectId: id, locale, actualReader, expectedReader };
      ratings.push(call);
      return call.promise;
    },
  };
  const write: RatingWrite = (input) => {
    const call = { ...deferred<boolean>(), ...input };
    writes.push(call);
    return call.promise;
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  let page = initialPage;
  let observers = observerCount;
  let root: ReturnType<typeof createRoot> | null = null;

  function PersonalPanel({ label }: { label: string }) {
    const session = useSession();
    const queryClient = useQueryClient();
    const personal = useSubjectPersonalReader({
      subjectId: page.subjectId,
      locale: page.locale,
      view: page.view,
      session,
      includeOwnRating: true,
      transport: readTransport,
    });
    const [status, setStatus] = useState<{ key: string; value: string } | null>(null);
    const binding = personal.binding;
    const readerKey = subjectReaderQuery(page.subjectId, page.locale, binding?.scope).queryKey;
    const ownKey = subjectOwnRatingQuery(page.subjectId, page.locale, binding?.scope).queryKey;
    const statusText = status?.key === binding?.key ? status.value : '';
    const apply = (units: number | null) => {
      if (!binding) return;
      const key = binding.key;
      setStatus({ key, value: `pending:${units ?? 'clear'}` });
      void applyOptimisticRatingChange({
        queryClient,
        subjectId: page.subjectId,
        locale: page.locale,
        binding,
        units,
        write,
        onFailure: () => {
          if (binding.isCurrent()) setStatus({ key, value: 'failed' });
        },
      }).then((saved) => {
        if (binding.isCurrent()) setStatus({ key, value: saved ? 'saved' : 'failed' });
      });
    };
    const own = personal.ownRating;
    return createElement(
      'section',
      {
        'data-panel': label,
        'data-reader-query': JSON.stringify(readerKey),
        'data-rating-query': JSON.stringify(ownKey),
      },
      createElement(
        'output',
        { 'data-slot': 'preferences' },
        `${personal.reader.spoilerLevel}:${personal.reader.suitability}`,
      ),
      createElement(
        'output',
        { 'data-slot': 'own-rating' },
        own?.kind === 'ready' ? String(own.units ?? 'clear') : 'unavailable',
      ),
      createElement('output', { 'data-slot': 'mutation-status' }, statusText),
      createElement('output', { 'data-slot': 'reader-id' }, personal.readerId ?? 'none'),
      createElement('button', { 'data-intent': 'set', onClick: () => apply(12) }, 'intent-set'),
      createElement('button', { 'data-intent': 'change', onClick: () => apply(16) }, 'intent-change'),
      createElement('button', { 'data-intent': 'clear', onClick: () => apply(null) }, 'intent-clear'),
      createElement(SubjectRatingControl, {
        question,
        subjectId: page.subjectId,
        locale: page.locale,
        returnTo: `/${page.locale}/subjects/${page.subjectId}/reader`,
        session: session.state,
        own,
        binding,
        write,
      }),
    );
  }

  function Journey() {
    return createElement(
      Fragment,
      null,
      ...Array.from({ length: observers }, (_, index) =>
        createElement(PersonalPanel, { key: `panel-${index + 1}`, label: `panel-${index + 1}` }),
      ),
    );
  }

  async function render(nextPage = page, nextObservers = observers) {
    page = nextPage;
    observers = nextObservers;
    if (!root) root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(StrictMode, null, createElement(QueryClientProvider, { client }, createElement(Journey))),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function setSession(session: Session) {
    await act(async () => {
      client.setQueryData(['session'], session);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function unmount() {
    if (!root) return;
    await act(async () => root!.unmount());
    root = null;
    await flush();
  }

  async function remount() {
    await render(page, observers);
  }

  return {
    client,
    readers,
    ratings,
    writes,
    readTransport,
    write,
    host,
    get page() {
      return page;
    },
    observers,
    render,
    setSession,
    flush,
    unmount,
    remount,
  };
}

function resolveReader(call: ReaderCall, spoilerLevel: 1 | 2 = 2) {
  call.resolve({
    reader: call.actualReader,
    preferences: { spoilerLevel, suitability: spoilerLevel === 2 ? 'show' : 'blur' },
  });
}

function resolveRating(call: RatingCall, units: number | null = 8) {
  call.resolve(
    call.actualReader === call.expectedReader
      ? { reader: call.actualReader, kind: 'ready', units }
      : { reader: call.actualReader, kind: 'unavailable' },
  );
}

function panel(harness: Harness, label = 'panel-1') {
  const node = harness.host.querySelector(`[data-panel="${label}"]`);
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

function value(harness: Harness, slot: string, label = 'panel-1') {
  return panel(harness, label).querySelector(`[data-slot="${slot}"]`)?.textContent ?? '';
}

function currentKey(harness: Harness, attribute: 'data-reader-query' | 'data-rating-query', label = 'panel-1') {
  return JSON.parse(panel(harness, label).getAttribute(attribute)!) as QueryKey;
}

async function clickIntent(harness: Harness, intent: 'set' | 'change' | 'clear', label = 'panel-1') {
  const button = panel(harness, label).querySelector(`[data-intent="${intent}"]`)! as unknown as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function clickControlSave(harness: Harness, label = 'panel-1') {
  const button = panel(harness, label).querySelector(
    '[data-slot="rating-control-reserved"] button',
  )! as unknown as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function resolvePair(harness: Harness, readerIndex: number, ratingIndex: number, spoiler: 1 | 2, units: number) {
  await act(async () => {
    resolveReader(harness.readers[readerIndex]!, spoiler);
    resolveRating(harness.ratings[ratingIndex]!, units);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function startCurrentRefetch(harness: Harness) {
  await act(async () => {
    void harness.client.refetchQueries({ queryKey: ['subject-reader', harness.page.subjectId, harness.page.locale] });
    void harness.client.refetchQueries({
      queryKey: ['subject-own-rating', harness.page.subjectId, harness.page.locale],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('subject preferences and own rating retire across the complete mounted reader/control journey', async () => {
  const readerA = { state: 'signed-in', subject: 'reader-a', csrfToken: null } as const;
  const readerB = { state: 'signed-in', subject: 'reader-b', csrfToken: 'csrf-b' } as const;
  const signedOut = { state: 'signed-out', subject: null, csrfToken: null } as const;
  const basePage = { subjectId: subjectA, locale: 'en', view: 'overview' };
  const main = makeHarness(readerA, basePage, 2);

  try {
    await main.render();
    await main.flush();
    expect(main.readers).toHaveLength(1); // Strict effect replay and two live observers share one prepared read.
    expect(main.ratings).toHaveLength(1);
    expect(main.readers[0]?.actualReader).toBe('reader-a');
    expect(main.ratings[0]?.expectedReader).toBe('reader-a');
    expect(main.readers[0]?.actualReader).toBe('reader-a'); // A null CSRF token still permits both read-only queries.
    await resolvePair(main, 0, 0, 2, 8);
    expect(value(main, 'preferences')).toBe('2:show');
    expect(value(main, 'own-rating')).toBe('8');
    expect(value(main, 'reader-id')).toBe('reader-a');

    // Current set, change and clear each perform one optimistic write with one fresh idempotency key.
    await clickIntent(main, 'set');
    expect(value(main, 'own-rating')).toBe('12');
    expect(main.writes).toHaveLength(1);
    expect(main.writes[0]).toMatchObject({ units: 12, expectedReader: 'reader-a' });
    await act(async () => {
      main.writes[0]!.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await clickIntent(main, 'change');
    expect(value(main, 'own-rating')).toBe('16');
    expect(main.writes).toHaveLength(2);
    await act(async () => {
      main.writes[1]!.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await clickIntent(main, 'clear');
    expect(value(main, 'own-rating')).toBe('clear');
    expect(main.writes).toHaveLength(3);
    await act(async () => {
      main.writes[2]!.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(new Set(main.writes.map((call) => call.idempotencyKey)).size).toBe(3);
    expect(main.writes.every((call) => /^[0-9a-f-]{36}$/i.test(call.idempotencyKey))).toBe(true);
    expect(main.client.getQueryData<SubjectOwnRating>(currentKey(main, 'data-rating-query'))).toEqual({
      reader: 'reader-a',
      kind: 'ready',
      units: null,
    });

    // A stale observer's failed operation cannot roll back the newer observer's accepted optimistic value.
    await clickIntent(main, 'set', 'panel-1');
    await clickIntent(main, 'change', 'panel-2');
    expect(value(main, 'own-rating', 'panel-1')).toBe('16');
    expect(value(main, 'own-rating', 'panel-2')).toBe('16');
    const olderWrite = main.writes[3]!;
    const newerWrite = main.writes[4]!;
    await act(async () => {
      olderWrite.resolve(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(value(main, 'own-rating', 'panel-2')).toBe('16');
    expect(value(main, 'mutation-status', 'panel-2')).toBe('pending:16');
    await act(async () => {
      newerWrite.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(main.client.getQueryData<SubjectOwnRating>(currentKey(main, 'data-rating-query'))).toEqual({
      reader: 'reader-a',
      kind: 'ready',
      units: 16,
    });

    // Slider draft is bound to this observer: a reader change remounts the draft and admits fresh B data.
    const oldRange = panel(main).querySelector('input[type="range"]') as unknown as HTMLInputElement;
    oldRange.focus();
    await act(async () => {
      oldRange.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(oldRange.getAttribute('aria-valuenow')).toBe('12');
    await clickControlSave(main);
    expect(main.writes).toHaveLength(6);
    expect(main.writes[5]).toMatchObject({ units: 12, expectedReader: 'reader-a' });
    await act(async () => {
      main.writes[5]!.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await main.setSession(readerB);
    expect(main.readers).toHaveLength(2);
    expect(main.ratings).toHaveLength(2);
    await resolvePair(main, 1, 1, 1, 8);
    expect(value(main, 'preferences')).toBe('1:blur');
    expect(value(main, 'own-rating')).toBe('8');
    const freshRange = panel(main).querySelector('input[type="range"]') as unknown as HTMLInputElement;
    expect(freshRange.getAttribute('aria-valuenow')).toBe('8');

    // Keep two old writes queued, focus B's control, then settle success/failure after the admission changed.
    await clickIntent(main, 'set', 'panel-1');
    await clickIntent(main, 'change', 'panel-2');
    const staleSuccess = main.writes[6]!;
    const staleFailure = main.writes[7]!;
    freshRange.focus();
    const focusedRange = window.document.activeElement;
    await act(async () => {
      staleSuccess.resolve(true);
      staleFailure.resolve(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(value(main, 'preferences')).toBe('1:blur');
    expect(value(main, 'own-rating')).toBe('8');
    expect(main.client.getQueryData<SubjectOwnRating>(currentKey(main, 'data-rating-query'))).toEqual({
      reader: 'reader-b',
      kind: 'ready',
      units: 8,
    });
    expect(window.document.activeElement).toBe(focusedRange);
    expect(value(main, 'mutation-status', 'panel-1')).toBe('');
    expect(value(main, 'mutation-status', 'panel-2')).toBe('');

    type Retirement =
      | 'sign-out'
      | 'viewer'
      | 'aba'
      | 'subject'
      | 'locale'
      | 'view'
      | 'unmount'
      | 'query-error'
      | 'query-removal';
    const retirements: Retirement[] = [
      'sign-out',
      'viewer',
      'aba',
      'subject',
      'locale',
      'view',
      'unmount',
      'query-error',
      'query-removal',
    ];
    const outcomes = ['success', 'failure', 'throw'] as const;

    for (const retirement of retirements) {
      for (const outcome of outcomes) {
        const harness = makeHarness(readerA, basePage);
        try {
          await harness.render();
          await harness.flush();
          expect(harness.readers).toHaveLength(1);
          expect(harness.ratings).toHaveLength(1);
          let staleReaderCall = harness.readers[0]!;
          let staleRatingCall = harness.ratings[0]!;
          let freshReaderIndex = 1;
          let freshRatingIndex = 1;
          let currentPage = basePage;

          if (retirement === 'query-error' || retirement === 'query-removal') {
            await resolvePair(harness, 0, 0, 2, 8);
            expect(value(harness, 'preferences')).toBe('2:show');
            await startCurrentRefetch(harness);
            staleReaderCall = harness.readers[1]!;
            staleRatingCall = harness.ratings[1]!;
            freshReaderIndex = 2;
            freshRatingIndex = 2;
          }

          await clickIntent(harness, 'set');
          const oldWrite = harness.writes[0]!;
          expect(oldWrite.expectedReader).toBe('reader-a');
          expect(value(harness, 'own-rating')).toBe('12');

          if (retirement === 'sign-out') {
            await harness.setSession(signedOut);
          } else if (retirement === 'viewer') {
            await harness.setSession(readerB);
          } else if (retirement === 'aba') {
            await act(async () => {
              harness.client.setQueryData(['session'], readerB);
              harness.client.setQueryData(['session'], readerA);
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          } else if (retirement === 'subject') {
            currentPage = { subjectId: subjectB, locale: basePage.locale, view: basePage.view };
            await harness.render(currentPage);
          } else if (retirement === 'locale') {
            currentPage = { subjectId: basePage.subjectId, locale: 'fr', view: basePage.view };
            await harness.render(currentPage);
          } else if (retirement === 'view') {
            currentPage = { subjectId: basePage.subjectId, locale: basePage.locale, view: 'details' };
            await harness.render(currentPage);
          } else if (retirement === 'unmount') {
            await harness.unmount();
            await harness.remount();
          } else if (retirement === 'query-error') {
            await act(async () => {
              staleReaderCall.reject(new Error('preference read failed'));
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
            await act(async () => {
              resolveRating(staleRatingCall, 20);
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
            expect(value(harness, 'preferences')).toBe('0:blur');
            expect(value(harness, 'own-rating')).toBe('unavailable');
            await startCurrentRefetch(harness);
          } else {
            const oldOwnKey = currentKey(harness, 'data-rating-query');
            harness.client.removeQueries({ queryKey: oldOwnKey, exact: true });
            await harness.flush();
          }

          if (retirement !== 'sign-out') {
            expect(harness.readers.length).toBeGreaterThanOrEqual(freshReaderIndex + 1);
            expect(harness.ratings.length).toBeGreaterThanOrEqual(freshRatingIndex + 1);
            const freshReader = harness.readers[freshReaderIndex]!;
            const freshRating = harness.ratings[freshRatingIndex]!;
            expect(freshReader.subjectId).toBe(currentPage.subjectId);
            expect(freshReader.locale).toBe(currentPage.locale);
            expect(freshRating.subjectId).toBe(currentPage.subjectId);
            expect(freshRating.locale).toBe(currentPage.locale);
            const currentReaderId = retirement === 'viewer' ? 'reader-b' : 'reader-a';
            expect(freshReader.actualReader).toBe(currentReaderId);
            expect(freshRating.expectedReader).toBe(currentReaderId);
            await resolvePair(harness, freshReaderIndex, freshRatingIndex, 1, 8);
            expect(value(harness, 'preferences')).toBe('1:blur');
            expect(value(harness, 'own-rating')).toBe('8');
          } else {
            expect(value(harness, 'preferences')).toBe('0:blur');
            expect(value(harness, 'own-rating')).toBe('unavailable');
          }

          if (retirement === 'query-error' || retirement === 'query-removal') {
            // Old reads from the prior same-reader observer arrive after a fresh same-reader response.
            await act(async () => {
              if (retirement === 'query-removal') {
                resolveReader(staleReaderCall, 2);
                resolveRating(staleRatingCall, 20);
              }
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          } else if (retirement !== 'sign-out') {
            await act(async () => {
              resolveReader(staleReaderCall, 2);
              resolveRating(staleRatingCall, 20);
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          } else {
            await act(async () => {
              resolveReader(staleReaderCall, 2);
              resolveRating(staleRatingCall, 20);
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          }

          if (outcome === 'success') oldWrite.resolve(true);
          else if (outcome === 'failure') oldWrite.resolve(false);
          else oldWrite.reject(new Error('write response was lost'));
          await harness.flush(); // Drains the old success/failure/throw and its queued finally callback.

          if (retirement === 'sign-out') {
            expect(value(harness, 'preferences')).toBe('0:blur');
            expect(value(harness, 'own-rating')).toBe('unavailable');
          } else {
            expect(value(harness, 'preferences')).toBe('1:blur');
            expect(value(harness, 'own-rating')).toBe('8');
            expect(harness.client.getQueryData<SubjectOwnRating>(currentKey(harness, 'data-rating-query'))).toEqual({
              reader: retirement === 'viewer' ? 'reader-b' : 'reader-a',
              kind: 'ready',
              units: 8,
            });
            expect(value(harness, 'mutation-status')).toBe('');
          }
          expect(harness.writes).toHaveLength(1); // No implicit retry creates a second command after uncertainty.
        } finally {
          await harness.unmount();
          harness.client.clear();
        }
      }
    }

    // Same-prepared identity mismatches refuse own-vote read and enhanced write before native I/O.
    const request = new Request('https://site.test/en/subjects/reader', {
      method: 'POST',
      headers: { authorization: 'Bearer prepared-reader' },
    });
    let nativeCalls = 0;
    const native = {
      subjects: () => {
        nativeCalls++;
        return { ratings: () => ({ vote: { get: async () => ({ status: 200, data: { units: 8 } }) } }) };
      },
    } as never;
    const actualReader = await preparedRatingReader(request, 'Bearer prepared-reader');
    expect(actualReader).not.toBeNull();
    await expect(
      readOwnRating(native, new Request(request.url, { headers: request.headers }), {}, subjectA, 'other-reader'),
    ).resolves.toMatchObject({ reader: actualReader, kind: 'unavailable' });
    expect(
      await writeSubjectRatingForCurrentReader(
        native,
        request,
        {},
        {
          subjectId: subjectA,
          units: 8,
          idempotencyKey: crypto.randomUUID(),
          expectedReader: 'other-reader',
        },
      ),
    ).toBe(false);
    expect(nativeCalls).toBe(0);
  } finally {
    await main.unmount();
    main.client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
