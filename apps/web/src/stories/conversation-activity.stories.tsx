import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { FeedResults } from '../features/feed/feed-results';
import { homeFeedItemPresentation } from '../features/feed/home-feed-item';
import { CommunityNativePresentation } from '../features/pages/subject-community-card-view';
import type { CommunityNativeCard } from '../features/pages/subject-community-card';
import type { FeedItem } from '../features/pages/home-feed-read';
import { homeFeedStoryPage } from '../kernel/fake/home-feed-stories';

type State = 'zero' | 'lower-bound' | 'withheld';
const threadId = '01a1a000-0000-7000-8000-000000000081';
const at = '2026-11-04T00:00:00.000Z';

function activity(state: State) {
  if (state === 'withheld') return { state: 'withheld' } as const;
  return {
    state: 'current' as const,
    cohort: 'public' as const,
    count: state === 'zero' ? { kind: 'exact' as const, value: 0 } : { kind: 'lower-bound' as const, value: 10_000 },
    lastActivityAt: state === 'zero' ? null : at,
  };
}

function subjectCard(state: State): CommunityNativeCard {
  const comments = activity(state);
  return {
    author: { displayName: 'Mira Okabe', handle: 'mira' },
    presentation: { state: 'current', language: 'en', spoiler: false },
    comments:
      comments.state === 'withheld'
        ? comments
        : { ...comments, source: { epoch: 1, position: '16' } },
    media: [],
  };
}

function ConversationActivityCards({ state }: { state: State }) {
  const feedItem = homeFeedStoryPage('en', true, 'mixed').feedItems.find(
    (item) => item.key.owner === 'content',
  )!;
  Object.assign(feedItem.summary, { conversationActivity: activity(state) });
  const items = [feedItem] as FeedItem[];
  const destination = `/en/threads/${encodeURIComponent(threadId)}/thread`;
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Conversation activity</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Recorded response states for card presentation. They are not native delivery evidence.
        </p>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <section aria-label="Home discussion" className="min-w-0 rounded-lg border p-4">
          <FeedResults
            regionLabel="Home"
            itemHeadingLevel={2}
            listAs="ol"
            result={{ state: 'ready', items, hasNext: false, availability: { state: 'complete' } }}
            messages={{
              loading: 'Loading',
              partial: 'Partial',
              empty: 'No discussions',
              sparse: 'No rows',
              retry: 'Retry',
              restart: 'Restart',
              failure: {
                request: 'Invalid',
                auth: 'Sign in',
                denied: 'Denied',
                closed: 'Closed',
                cursor: 'Expired',
                deadline: 'Timeout',
                unavailable: 'Unavailable',
              },
            }}
            getItemKey={(item) => item.id}
            itemPresentation={(item) => homeFeedItemPresentation(item, 'en')}
          />
        </section>
        <section aria-label="Subject discussion" className="min-w-0 rounded-lg border p-4">
          <article className="min-w-0 space-y-3">
            <h2 className="break-words text-lg font-semibold">
              <a className="text-primary underline underline-offset-4" href={destination}>
                What does the fox teach the prince?
              </a>
            </h2>
            <CommunityNativePresentation
              card={subjectCard(state)}
              summary="The conversation about friendship changes the meaning of the journey."
              locale="en"
              now="2026-11-04T00:05:00.000Z"
              retryHref="/en/subjects/book/discussion"
            />
          </article>
        </section>
      </div>
    </main>
  );
}

const meta = {
  title: 'Patterns/Feed/Conversation activity',
  component: ConversationActivityCards,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof ConversationActivityCards>;
export default meta;
type Story = StoryObj<typeof meta>;

const inspect: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const destinations = canvas.getAllByRole('link');
  await expect(destinations.some((link) => link.getAttribute('href')?.includes('/threads/'))).toBe(true);
  await expect(canvasElement.querySelector('a a, a button, button a')).toBeNull();
};

export const CurrentZero: Story = {
  args: { state: 'zero' },
  play: inspect,
};

export const PopulatedLowerBound: Story = {
  args: { state: 'lower-bound' },
  play: inspect,
};

export const WithheldWithRetry: Story = {
  args: { state: 'withheld' },
  play: inspect,
};
