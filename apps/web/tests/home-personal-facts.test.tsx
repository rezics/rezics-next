import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';
import {
  admittedFeedWorkId,
  homeWorkLibraryRow,
  type HomeWorkLibraryProjection,
} from '../src/features/feed/home-work-library/contract';
import {
  homeWorkLibraryFeedProjection,
  homeWorkLibraryPage,
  type HomeNativePersonalPage,
} from '../src/features/feed/home-work-library/page';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';
import { setLocale } from '../src/paraglide/runtime.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
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
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { HomeFeedConsumer } = await import('../src/features/pages/home-feed');
const { m } = await import('../src/paraglide/messages.js');

const standardQuestion = {
  id: '00000000-0000-7000-8000-000000000001',
  revision: 1,
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
  meaning: 'Overall',
};
const spaceId = '00000000-0000-7000-8000-000000000002';
const readerId = 'reader-1';

function workItem(): FeedItem {
  const work = homeFeedStoryPage('en', true, 'mixed').feedItems.find((item) => admittedFeedWorkId(item));
  if (!work) throw new Error('The Home story fixture must supply an admitted work row');
  return work;
}

function nativePage(work: FeedItem, overrides: Partial<{ units: number; entryState: string | null }> = {}) {
  return {
    state: 'current',
    question: standardQuestion,
    rows: [
      {
        rowKey: work.id,
        subjectId: work.destination.id,
        entry: { state: 'present', incarnationId: null, entryState: overrides.entryState ?? 'reading', revision: 4 },
        vote: {
          state: 'present',
          questionId: standardQuestion.id,
          questionRevision: 1,
          units: overrides.units ?? 14,
          revision: 2,
        },
        actions: { state: 'current', allowed: [] },
      },
    ],
  } satisfies HomeNativePersonalPage;
}

function pageWith(work: FeedItem, viewerPersonalActions: HomeNativePersonalPage): FeedPage {
  return {
    feedItems: [work],
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
    viewerPersonalActions,
  };
}

test('native personal facts map by original occurrence and Subject, and never fill a missing or foreign fact', () => {
  const work = workItem();
  const native: HomeNativePersonalPage = {
    state: 'current',
    question: standardQuestion,
    rows: [
      {
        rowKey: 'occurrence-1',
        subjectId: 'work-1',
        entry: { state: 'present', incarnationId: 'incarnation-1', entryState: 'reading', revision: 4 },
        vote: { state: 'present', questionId: standardQuestion.id, questionRevision: 1, units: 14, revision: 2 },
        actions: { state: 'current', allowed: [{ action: 'vote.set', operations: ['vote.set'] }] },
      },
      {
        rowKey: 'occurrence-2',
        subjectId: 'work-2',
        entry: { state: 'present', incarnationId: null, entryState: null, revision: 1 },
        vote: { state: 'absent', questionId: 'other-question', questionRevision: 3 },
        actions: { state: 'unavailable', reason: 'dependency' },
      },
    ],
  };
  const page = homeWorkLibraryPage(native, readerId);
  expect(page.state).toBe('ready');
  expect(page.rows[0]).toEqual({
    rowKey: 'occurrence-1',
    subjectId: 'work-1',
    entry: {
      state: 'present',
      value: { subjectId: 'work-1', state: 'reading', revision: 4, incarnationId: 'incarnation-1' },
    },
    score: { state: 'present', value: { reader: readerId, kind: 'ready', units: 14 } },
    actions: { state: 'current', allowed: [{ action: 'vote.set', operations: ['vote.set'] }] },
  });
  // A null entry state and a vote on another question are unavailable, not absent.
  expect(page.rows[1]).toEqual({
    rowKey: 'occurrence-2',
    subjectId: 'work-2',
    entry: { state: 'unavailable' },
    score: { state: 'unavailable' },
    actions: { state: 'unavailable' },
  });
  // A non-standard scale cannot supply a Home score.
  const rescaled = homeWorkLibraryPage(
    { ...native, question: { ...standardQuestion, scale: { min: 0, max: 10, displayStep: 1 } } },
    readerId,
  );
  expect(rescaled.rows[0]?.score).toEqual({ state: 'unavailable' });
  expect(homeWorkLibraryPage({ state: 'unavailable', reason: 'identity', retryable: true }, readerId)).toEqual({
    state: 'unavailable',
    rows: [],
  });

  const lease = { subscribe: () => () => {}, snapshot: () => 0, isCurrent: () => true };
  const projection: HomeWorkLibraryProjection = homeWorkLibraryFeedProjection({
    native,
    scope: {
      reader: readerId,
      credentialEpoch: 'credential-1',
      source: 'home',
      observation: 'page-1',
      locale: 'en',
      route: '/',
    },
    lease,
  });
  expect(homeWorkLibraryRow(projection, 'occurrence-1', 'work-1')?.subjectId).toBe('work-1');
  // Another occurrence of the same Subject, or the wrong Subject, is not that row.
  expect(homeWorkLibraryRow(projection, 'occurrence-1', 'work-2')).toBeUndefined();
  expect(homeWorkLibraryRow(projection, 'occurrence-9', 'work-1')).toBeUndefined();
  expect(admittedFeedWorkId(work)).toBe(work.destination.id);
});

const host = window.document.createElement('div');
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function paint(element: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
}

beforeEach(() => {
  setLocale('en', { reload: false });
  client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: readerId, csrfToken: 'csrf' });
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('mounted Home shows the installed facts for its admitted work row, retires them on sign-out and reports only native unavailability', async () => {
  const work = workItem();
  const current = pageWith(work, nativePage(work));
  const ready = { state: 'ready' as const, page: current };
  const consumer = (key: string, initial: typeof ready, signedIn: boolean, reader: string | null): ReactNode => (
    <HomeFeedConsumer
      key={key}
      initial={initial}
      locale="en"
      signedIn={signedIn}
      origin="https://site.test"
      reader={reader}
      credentialEpoch={reader ? `${reader}:csrf` : null}
      read={async () => initial}
      readKinds={async () => ({ status: 'unavailable' })}
      readSpace={async () => ({
        status: 'ready',
        space: { spaceId, realmId: spaceId, headRevisionId: spaceId, title: 'Room', address: 'reading-room' },
      })}
      readQuestions={async () => ({ status: 'unavailable', code: 'unavailable' })}
      readQuestion={async () => ({
        status: 'ready',
        question: {
          id: standardQuestion.id,
          revision: 1,
          label: 'Overall',
          grain: 'work',
          scale: standardQuestion.scale,
        },
      })}
    />
  );

  await paint(consumer('signed-in', ready, true, readerId));
  const entry = host.querySelector('[data-slot="home-work-library-entry"]');
  expect(entry?.textContent).toContain(m.library_other({}, { locale: 'en' }));
  expect(host.querySelector('[data-slot="home-work-library-entry-unavailable"]')).toBeNull();
  // Units 14 on the standard 0–20 scale are the same 7 out of 10 that Library shows.
  expect(host.querySelector('[data-slot="home-work-library-score"]')?.textContent).toContain('7 / 10');
  expect(host.querySelector('[data-slot="home-work-library-score-unavailable"]')).toBeNull();

  // Sign-out withdraws the private rows immediately, with no unavailable copy in their place.
  await paint(consumer('signed-in', ready, false, null));
  expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
  expect(host.querySelector('[data-slot="home-work-library-score"]')).toBeNull();
  expect(host.querySelector('[data-slot="home-work-library-entry-unavailable"]')).toBeNull();

  // Native unavailability is the only source of unavailable copy for signed-in personal facts.
  const unavailable = {
    state: 'ready' as const,
    page: pageWith(work, { state: 'unavailable', reason: 'identity', retryable: true }),
  };
  await paint(consumer('native-unavailable', unavailable, true, readerId));
  expect(host.querySelector('[data-slot="home-work-library-entry-unavailable"]')).not.toBeNull();
  expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
  expect(host.querySelector('[data-slot="home-work-library-score"]')).toBeNull();
});
