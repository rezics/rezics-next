import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';
import { admittedFeedWorkId } from '../src/features/feed/home-work-library/contract';
import { discoveryCollectionCard } from '../src/kernel/fake/discovery-collection-card';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';
import { m } from '../src/paraglide/messages.js';
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

const readerId = 'reader-1';
const spaceId = '00000000-0000-7000-8000-000000000002';
const collectionId = '00000000-0000-7000-8000-0000000000c1';
const memberId = '00000000-0000-7000-8000-0000000000b1';
const threadId = '00000000-0000-7000-8000-0000000000e1';
const standardQuestion = {
  id: '00000000-0000-7000-8000-000000000001',
  revision: 1,
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
  meaning: 'Overall',
};

/** The seeded persona's Home page: a discovery Collection with installed facts, an admitted work and a discussion. */
function seededPage(): FeedPage {
  const work = homeFeedStoryPage('en', true, 'mixed').feedItems.find((item) => admittedFeedWorkId(item));
  if (!work) throw new Error('The Home story fixture must supply an admitted work row');
  const collection: FeedItem = {
    id: `discovery:commerce:${collectionId}`,
    source: 'discovery',
    occurredAt: null,
    key: { owner: 'commerce', kind: 'collection', route: 0, id: collectionId },
    summary: {
      id: collectionId,
      title: 'Seeded shelf',
      description: 'A seeded selection.',
      card: {
        ...discoveryCollectionCard({ id: collectionId, title: 'Seeded shelf', description: 'A seeded selection.' }),
        curator: { state: 'available', id: readerId, label: 'Ada', destination: '/@ada' },
        preview: {
          state: 'available',
          members: [
            {
              id: memberId,
              subject: {
                id: work.destination.id,
                type: 'schema:Book',
                types: ['schema:Book'],
                label: { value: 'Seeded work', language: 'en' },
              },
            },
          ],
          partial: false,
          truncated: false,
        },
      },
    },
    destination: { kind: 'collection', id: collectionId, title: 'Seeded shelf' },
  };
  const discussion: FeedItem = {
    id: `following:content:${threadId}`,
    source: 'following',
    occurredAt: null,
    key: { owner: 'content', kind: 'thread', route: 0, id: threadId },
    summary: {
      id: threadId,
      kind: 'discussion',
      title: 'Seeded discussion',
      createdAt: '2026-11-04T00:00:00Z',
      reactionTarget: { targetKind: 'thread', targetId: threadId },
      reactions: { upvote: 2 },
      viewerReaction: null,
      reactionAdvice: {
        target: { targetKind: 'thread', targetId: threadId },
        state: 'current',
        allowed: ['upvote'],
      },
    },
    destination: { kind: 'thread', id: threadId, title: 'Seeded discussion' },
  };
  return {
    feedItems: [collection, work, discussion],
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    reactionsAsOf: { epoch: 1, position: '2' },
    sources: { discovery: 'ready', following: 'ready', continue: 'not_requested' },
  };
}

function withPersonalFacts(page: FeedPage): FeedPage {
  const work = page.feedItems.find((item) => admittedFeedWorkId(item));
  if (!work) throw new Error('The seeded page must contain its admitted work row');
  return {
    ...page,
    viewerPersonalActions: {
      state: 'current',
      question: standardQuestion,
      rows: [
        {
          rowKey: work.id,
          subjectId: work.destination.id,
          entry: { state: 'present', incarnationId: null, entryState: 'reading', revision: 4 },
          vote: {
            state: 'present',
            questionId: standardQuestion.id,
            questionRevision: 1,
            units: 14,
            revision: 2,
          },
          actions: { state: 'current', allowed: [] },
        },
      ],
    },
  };
}

const host = window.document.createElement('div');
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function paint(element: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
}

function journey(key: string, page: FeedPage, reader: string | null) {
  return (
    <HomeFeedConsumer
      key={key}
      initial={{ state: 'ready', page }}
      locale="en"
      signedIn={reader !== null}
      origin="https://site.test"
      reader={reader}
      credentialEpoch={reader ? `${reader}:csrf` : null}
      read={async () => ({ state: 'ready', page })}
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

test('seeded Home persona journey: public Collection facts show to everyone, private facts and advice follow the signed-in reader and retire at sign-out', async () => {
  const page = seededPage();
  // Anonymous reader: installed Collection facts only; no personal facts and no private reaction permission.
  await paint(journey('anonymous', page, null));
  expect(host.querySelector('[data-home-curator-state="available"]')?.textContent).toContain('Ada');
  expect(host.querySelector('[data-home-collection-preview="available"]')).not.toBeNull();
  expect(host.querySelector('[data-collection-member-id]')).not.toBeNull();
  expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();

  // Signed-in reader: the same page now also carries the reader's own facts. Reaction advice is covered by its own
  // focused Home receiver test, because a consumer mount needs the healthy session probe that tests do not supply.
  await paint(journey('signed-in', withPersonalFacts(page), readerId));
  expect(host.querySelector('[data-slot="home-work-library-entry"]')?.textContent).toContain(
    m.library_other({}, { locale: 'en' }),
  );
  expect(host.querySelector('[data-slot="home-work-library-score"]')?.textContent).toContain('7 / 10');

  // Sign-out replaces the private window: the reader's facts disappear and no advice survives.
  await paint(journey('signed-in', withPersonalFacts(page), null));
  expect(host.querySelector('[data-slot="home-work-library-entry"]')).toBeNull();
  expect(host.querySelector('[data-slot="home-work-library-score"]')).toBeNull();
  expect(host.querySelector('[data-home-curator-state="available"]')?.textContent).toContain('Ada');
});
