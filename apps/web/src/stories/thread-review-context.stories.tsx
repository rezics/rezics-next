import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText } from '@rezics/document';
import { ThreadReviewContext, type ThreadReviewContextValue } from '../threads/thread-review-context';
import { threadLocation } from '../threads/thread-href';
import { getLocale } from '../paraglide/runtime.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const subjectId = '44444444-4444-4444-8444-444444444444';
const questionId = '55555555-5555-4555-8555-555555555555';
const post = {
  id: postId,
  threadId,
  route: 0,
  authorId: '66666666-6666-4666-8666-666666666666',
  parentId: null,
  licence: 'CC0-1.0',
  subjectIds: [],
  boardId: '77777777-7777-4777-8777-777777777777',
  visibility: 'published' as const,
  securityRevision: '1',
  availability: 'available' as const,
  createdAt: '2026-11-04T00:00:00.000Z',
  revisedAt: null,
  sha256: 'a'.repeat(64),
  mediaIds: [],
  voteCitation: null,
  revisionId,
  body: fromPlainText('The review stays readable while its exact citation is inspected.', 'blocks'),
};

function context(target: 'available' | 'withheld' | 'unavailable'): ThreadReviewContextValue {
  return {
    source: { threadId, postId, revisionId },
    target:
      target === 'available'
        ? {
            state: 'available',
            subject: { id: subjectId, kind: 'visualNovel', label: { value: 'Reviewed work', language: 'en' } },
          }
        : { state: target },
    citations: {
      state: 'current',
      items: [
        {
          postId,
          sourceRevisionId: revisionId,
          citation:
            target === 'available'
              ? {
                  state: 'available',
                  questionId,
                  units: 0,
                  voteRevision: 3,
                  metadata: { state: 'unavailable' },
                }
              : { state: 'withheld' },
        },
      ],
    },
  };
}

function ReviewContextStory({ state }: { state: 'available' | 'withheld' | 'unavailable' }) {
  const locale = getLocale();
  const thread = { id: threadId, title: 'A careful review' };
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <p className="text-sm text-muted-foreground">
        The review target and publication-time citation come from the admitted thread page.
      </p>
      <ThreadReviewContext
        context={context(state)}
        thread={thread}
        posts={[post]}
        cursor="opaque-board-page"
        boardReturn="/en/boards/77777777-7777-4777-8777-777777777777?sort=active"
        locale={locale}
      />
      <a className="underline" href={threadLocation(locale, thread, 'opaque-board-page', postId)}>
        Return to the selected post
      </a>
    </main>
  );
}

const meta = {
  title: 'Interfaces/Community/Thread review context',
  component: ReviewContextStory,
  parameters: { layout: 'fullscreen' },
  args: { state: 'available' },
} satisfies Meta<typeof ReviewContextStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AvailableCitation: Story = { args: { state: 'available' } };
export const WithheldTarget: Story = { args: { state: 'withheld' } };
export const UnavailableTarget: Story = { args: { state: 'unavailable' } };
