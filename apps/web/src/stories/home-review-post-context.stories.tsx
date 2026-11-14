import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedItem, FeedPage } from '../features/pages/home-feed-read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

type FollowingPost = Extract<FeedItem, { summary: { threadId: string } }>;
type ReviewContext = NonNullable<FollowingPost['summary']['reviewContext']>;
type Scenario =
  | 'populated'
  | 'citation-states'
  | 'concealed-target'
  | 'concealed-parent'
  | 'replacement'
  | 'discovery-fallback';
type Viewer = 'reader-a' | 'reader-b';

const ids = {
  thread: '00000000-0000-7000-8000-000000000101',
  post: '00000000-0000-7000-8000-000000000102',
  secondPost: '00000000-0000-7000-8000-000000000103',
  subject: '00000000-0000-7000-8000-000000000104',
  question: '00000000-0000-7000-8000-000000000105',
  parent: '00000000-0000-7000-8000-000000000106',
  revision: '00000000-0000-7000-8000-000000000107',
  author: '00000000-0000-7000-8000-000000000108',
};
const parentExcerpt = 'The final chapter changes how I read the opening scene.';

function nativeContext(revision: number): ReviewContext {
  return {
    target: {
      state: 'available',
      subject: {
        id: ids.subject,
        kind: 'schema:Book',
        label: { value: revision ? 'Letters from B-612 · current edition' : 'Letters from B-612', language: 'en' },
      },
    },
    citation: {
      state: 'available',
      question: {
        id: ids.question,
        revision: 9 + revision,
        label: 'How clearly does the ending connect to the opening?',
        grain: 'work',
        scale: { min: 0, max: 20, displayStep: 1 },
      },
      units: revision ? 6 : 17,
      voteRevision: 4 + revision,
    },
  };
}

function reviewPost(id: string, context: ReviewContext): FollowingPost {
  return {
    id: `prepared-review-post:${id}`,
    source: 'following',
    key: { owner: 'content', kind: 'post', route: 0, id },
    occurredAt: '2026-11-04T10:00:00Z',
    summary: {
      id,
      threadId: ids.thread,
      title: 'A reply about the ending',
      createdAt: '2026-11-04T09:58:00Z',
      author: { displayName: 'Reply reader', handle: 'reply_reader', avatar: null },
      excerpt: 'I noticed the same connection. The repeated image makes more sense on a second reading.',
      reviewContext: context,
      parentContext: {
        kind: 'reply',
        parent: {
          state: 'available',
          id: ids.parent,
          revisionId: ids.revision,
          createdAt: '2026-11-04T09:40:00Z',
          author: { id: ids.author, displayName: 'Parent reader', handle: 'parent_reader' },
          excerpt: parentExcerpt,
          language: 'en',
          spoiler: true,
        },
      },
    },
    destination: { kind: 'post', id, postId: id, threadId: ids.thread, title: 'A reply about the ending' },
  };
}

function reviewThread(context?: ReviewContext): FeedItem {
  return {
    id: 'prepared-discovery-review',
    source: 'discovery',
    key: { owner: 'content', kind: 'review', route: 0, id: ids.thread },
    occurredAt: null,
    summary: {
      id: ids.thread,
      kind: 'review',
      title: 'Reading the ending again',
      excerpt: 'The closing scene brought me back to the promise of the first chapter.',
      author: { displayName: 'Review reader', handle: 'review_reader' },
      subject: { id: ids.subject, title: 'Letters from B-612' },
      ...(context ? { reviewContext: context } : {}),
    },
    destination: { kind: 'thread', id: ids.thread, title: 'Reading the ending again' },
  };
}

function preparedRows(scenario: Scenario, revision: number, viewer: Viewer): FeedItem[] {
  const context = nativeContext(revision);
  switch (scenario) {
    case 'discovery-fallback':
      return [reviewThread()];
    case 'citation-states':
      return [
        reviewPost(ids.post, { target: context.target, citation: { state: 'absent' } }),
        reviewPost(ids.secondPost, { target: context.target, citation: { state: 'withheld' } }),
      ];
    case 'concealed-target':
      return [reviewPost(ids.post, { target: { state: 'withheld' }, citation: context.citation })];
    case 'concealed-parent': {
      const concealed: ReviewContext = { target: { state: 'withheld' }, citation: { state: 'withheld' } };
      return [
        reviewThread(concealed),
        ...([{ state: 'withheld' }, { state: 'removed', id: ids.parent }] as const).map((parent, index) => {
          const post = reviewPost(index ? ids.secondPost : ids.post, concealed);
          return { ...post, summary: { ...post.summary, parentContext: { kind: 'reply' as const, parent } } };
        }),
      ];
    }
    case 'replacement':
      return [
        reviewPost(
          ids.post,
          viewer === 'reader-b' ? { target: { state: 'withheld' }, citation: { state: 'withheld' } } : context,
        ),
      ];
    case 'populated':
      return [reviewThread(context), reviewPost(ids.post, context)];
  }
}

function HomeReviewPostContext({ scenario }: { scenario: Scenario }) {
  const [revision, setRevision] = useState(0);
  const [viewer, setViewer] = useState<Viewer>('reader-a');
  const client = useMemo(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['session'], {
      state: 'signed-in',
      subject: 'reader-a',
      csrfToken: 'prepared-reader-a',
    });
    return queryClient;
  }, []);
  const result = useMemo(
    () => ({
      state: 'ready' as const,
      page: {
        feedItems: preparedRows(scenario, revision, viewer),
        next: null,
        asOf: '2026-11-04T10:01:00Z',
        sources: {
          discovery: ['discovery-fallback', 'populated', 'concealed-parent'].includes(scenario)
            ? 'ready'
            : 'not_requested',
          following: scenario === 'discovery-fallback' ? 'not_requested' : 'ready',
          continue: 'not_requested',
        },
      } satisfies FeedPage,
    }),
    [scenario, revision, viewer],
  );
  return (
    <QueryClientProvider client={client}>
      <div className="space-y-4 p-4 sm:p-8">
        {scenario === 'replacement' ? (
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
            <button className="min-h-11 rounded border px-3" onClick={() => setRevision((value) => value + 1)}>
              Replace page
            </button>
            <button
              className="min-h-11 rounded border px-3"
              onClick={() => {
                const next = viewer === 'reader-a' ? 'reader-b' : 'reader-a';
                client.setQueryData(['session'], {
                  state: 'signed-in',
                  subject: next,
                  csrfToken: `prepared-${next}`,
                });
                setViewer(next);
              }}
            >
              Switch viewer
            </button>
            <output aria-live="polite">
              Viewer: {viewer}; page: {revision + 1}
            </output>
          </div>
        ) : null}
        <HomeFeed result={result} locale={getLocale()} signedIn />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Discovery/Home review-post context',
  id: 'pages-discovery-home-review-post-context',
  component: HomeReviewPostContext,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative installed-format reviews and Following posts rendered by HomeFeed, including populated citations, concealed review targets, and removed or concealed immediate parents. Replacement keeps row and parent identities equal to exercise spoiler retirement. These stories are source evidence; native and phone/desktop acceptance remain deferred.',
      },
    },
  },
} satisfies Meta<typeof HomeReviewPostContext>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedReviewPost: Story = {
  args: { scenario: 'populated' },
  play: async ({ canvasElement }) => {
    for (const row of canvasElement.querySelectorAll('[data-feed-id]')) {
      for (const selector of [
        'h2',
        '[data-feed-card-review-context]',
        '[data-feed-card-reviewed-subject]',
        '[data-feed-review-citation]',
      ])
        await expect(row.querySelectorAll(selector)).toHaveLength(1);
      await expect(row.querySelectorAll('[data-feed-review-context], [data-feed-parent-context]')).toHaveLength(0);
    }
    await expect(canvasElement.querySelectorAll('[data-feed-card-parent]')).toHaveLength(1);
    await expect(within(canvasElement).queryByText(parentExcerpt)).toBeNull();
  },
};
export const AbsentAndWithheldCitation: Story = { args: { scenario: 'citation-states' } };
export const ConcealedTarget: Story = { args: { scenario: 'concealed-target' } };
export const ConcealedReviewAndParents: Story = {
  args: { scenario: 'concealed-parent' },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-feed-review-citation="withheld"]')).toHaveLength(3);
    await expect(canvasElement.querySelectorAll('[data-feed-card-parent="withheld"]')).toHaveLength(1);
    await expect(canvasElement.querySelectorAll('[data-feed-card-parent="removed"] a')).toHaveLength(1);
    await expect(
      canvasElement.querySelectorAll(
        '[data-feed-card-reviewed-subject], [data-question-id], [data-feed-card-parent-revision]',
      ),
    ).toHaveLength(0);
    await expect(within(canvasElement).queryByText(parentExcerpt)).toBeNull();
  },
};
export const DiscoveryReviewFallback: Story = { args: { scenario: 'discovery-fallback' } };
export const PageAndViewerReplacement: Story = {
  args: { scenario: 'replacement' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const parent = () => canvasElement.querySelector<HTMLElement>('[data-feed-card-parent="available"]')!;
    const reveal = () => within(parent()).getByRole('button', { name: m.thread_reveal_spoiler() });
    await expect(canvasElement.querySelector('[data-feed-card-reviewed-subject] a')).toHaveTextContent(
      'Letters from B-612',
    );
    await expect(canvasElement.querySelector('[data-question-id]')).toHaveAttribute('data-units', '17');
    await expect(reveal()).toBeEnabled();
    await userEvent.click(reveal());
    await expect(within(parent()).getByText(parentExcerpt)).toBeVisible();
    await userEvent.click(within(parent()).getByRole('button', { name: m.subject_spoiler_hide() }));
    await expect(within(parent()).queryByText(parentExcerpt)).toBeNull();
    await userEvent.click(reveal());
    await userEvent.click(canvas.getByRole('button', { name: 'Replace page' }));
    await expect(canvasElement.querySelector('[data-question-id]')).toHaveAttribute('data-units', '6');
    await expect(canvasElement.querySelector('[data-question-id]')).toHaveAttribute('data-question-revision', '10');
    await expect(reveal()).toBeEnabled();
    await expect(within(parent()).queryByText(parentExcerpt)).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Switch viewer' }));
    await expect(canvasElement.querySelector('[data-feed-card-reviewed-subject]')).toBeNull();
    await expect(canvasElement.querySelector('[data-question-id]')).toBeNull();
    await expect(canvasElement.querySelector('[data-feed-review-citation="withheld"]')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Switch viewer' }));
    await expect(canvasElement.querySelector('[data-question-id]')).toHaveAttribute('data-units', '6');
    await expect(reveal()).toBeEnabled();
    await expect(within(parent()).queryByText(parentExcerpt)).toBeNull();
    await expect(canvasElement.querySelector('a a, a button, button a')).toBeNull();
  },
};
