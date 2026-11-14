import type { BoardPageResponse, ReadingPageResponse } from '@rezics/client';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';
import { authoredReadingPage } from './thread-reading-page';
import recordedSubject from '../recorded/subject.json';

/** Authored examples for the mounted routes. Counts and advice describe these fixtures only. */
const id = (value: number) => `0193c100-0000-7000-8000-${String(value).padStart(12, '0')}`;
export const conversationBoardId = id(1);
export const conversationBoardTitle = 'The reading room';
export const conversationBoardCursor = 'reading+room/position==';
export const conversationSparseCursor = 'reading+room/sparse==';
export const conversationThreadCursor = 'reply+branch/next==';
export const conversationQuestionId = id(90);
export const conversationSubjectId = recordedSubject.subject.id;
const createdAt = '2026-11-04T10:00:00.000Z';
const source = { epoch: 2, position: '18' };
const authors = [
  { id: 'story-viewer', displayName: 'Casey Reader', handle: 'casey', avatar: null },
  { id: id(20), displayName: 'Mira Okabe', handle: 'mira', avatar: null },
  { id: id(21), displayName: 'Jonas Lind', handle: 'jonas', avatar: null },
  {
    id: id(22),
    displayName: 'A reader with a long name who keeps detailed notes',
    handle: 'careful_reader',
    avatar: null,
  },
];
type SuppliedReactions = { reactions: { like: number }; viewerReaction: null };
type AvailablePost = Extract<ReadingPageResponse['thread']['firstPost'], { availability: 'available' }> &
  SuppliedReactions;
type Thread = Omit<ReadingPageResponse['thread'], 'firstPost'> &
  SuppliedReactions & {
    availability: 'available';
    firstPost: AvailablePost;
  };

function post(threadId: string, index: number, text: string, parentId: string | null = null): AvailablePost {
  return {
    id: id(1000 + index),
    threadId,
    boardId: conversationBoardId,
    route: index,
    authorId: authors[1 + (index % (authors.length - 1))]!.id,
    parentId,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt,
    revisedAt: null,
    revisionId: id(2000 + index),
    sha256: 'a'.repeat(64),
    mediaIds: [],
    voteCitation: null,
    body: fromPlainText(text, 'blocks'),
    reactions: { like: index === 1 ? 2 : 0 },
    viewerReaction: null,
  };
}

function thread(
  index: number,
  title: string | null,
  text: string,
  kind: 'discussion' | 'review' = 'discussion',
  illustration?: { id: string; alt: string },
): Thread {
  const threadId = id(100 + index);
  const opening = post(threadId, index * 20, text);
  const firstPost: AvailablePost = {
    ...opening,
    voteCitation: kind === 'review' ? { questionId: conversationQuestionId, units: 0, revision: 3 } : null,
    ...(illustration
      ? {
          mediaIds: [illustration.id],
          body: {
            ...opening.body,
            doc: {
              type: 'doc',
              content: [
                ...opening.body.doc.content!,
                {
                  type: 'image',
                  attrs: { id: 'unavailable-illustration', src: illustration.id, alt: illustration.alt },
                },
              ],
            },
          },
        }
      : {}),
  };
  return {
    id: threadId,
    boardId: conversationBoardId,
    route: index,
    authorId: opening.authorId,
    kind,
    title,
    licence: opening.licence,
    subjectIds: [],
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt,
    firstPost,
    reactions: { like: 3 },
    viewerReaction: null,
  };
}

export const conversationDiscussion = thread(
  0,
  'What changes when we read the same story again?',
  'On my first reading I followed the journey. This time I noticed the pauses between each visit.\n\n' +
    'Which small detail changed the story for you? Share a passage or an observation, and tell us what made it stay with you.',
);
export const conversationReview = thread(
  1,
  'A small book with room for a second reading',
  'The quiet conversations are what make this book worth returning to. The illustrations slow the reading down in a useful way.\n\n' +
    'I wanted more time with the final encounter, but its restraint is also part of the appeal. This is a review of the work, with the rating I cited when I published it.',
  'review',
);
export const conversationLong = thread(
  2,
  'Reading together across editions, translations and a very long winter evening',
  [
    'A reading notebook',
    'We compared two translations at the library, with each reader choosing a short passage. A different word could change the rhythm without changing the event.',
    'The first reader noticed the repeated questions. The second paid attention to what the narrator left unanswered. Neither observation cancelled the other; we put them beside each other.',
    'Our notes became a conversation about rereading: what we remember, what we miss, and how another reader gives a familiar scene a different shape.',
    'We kept the original passages beside our notes so that anyone joining later could follow the comparison. Long notes should still be readable on a phone and leave room for a short response.',
    'The final question is open: which translation would you recommend for reading aloud, and why?',
  ].join('\n\n'),
);
export const conversationFailure = thread(
  3,
  'An illustration we can still discuss',
  'The text remains available while the illustration and activity summary cannot be loaded. You can still follow the supplied replies and keep writing a response.',
  'discussion',
  { id: id(80), alt: 'A sketch of the opening scene' },
);
export const conversationUntitled = thread(
  4,
  null,
  'A question from the margins: what did you notice on your last reading?',
);
const allThreads = [
  conversationDiscussion,
  conversationReview,
  conversationLong,
  conversationFailure,
  conversationUntitled,
];
const board: BoardPageResponse['board'] = {
  id: conversationBoardId,
  realmId: null,
  community: null,
  route: 0,
  title: conversationBoardTitle,
  purpose: 'discussion',
  visibility: 'published',
  securityRevision: '1',
  availability: 'available',
  createdAt,
};

export const conversationDiscussionReplies = [
  post(
    conversationDiscussion.id,
    1,
    'The pause before the fox answers changed the whole scene for me.',
    conversationDiscussion.firstPost.id,
  ),
  post(conversationDiscussion.id, 2, 'I agree. Reading it aloud makes the pause much easier to hear.', id(1001)),
  post(
    conversationDiscussion.id,
    3,
    'Our group compared that scene in two translations. The shorter sentence felt more patient.',
    id(1002),
  ),
  post(conversationDiscussion.id, 4, 'I came back to the opening illustration. It asks the reader to look twice.'),
  post(
    conversationDiscussion.id,
    5,
    'That is a lovely way to connect the opening with the later encounters.',
    id(1004),
  ),
];
const reviewReplies = [
  post(
    conversationReview.id,
    21,
    'Thank you for separating the publication-time rating from the discussion of the ending.',
    conversationReview.firstPost.id,
  ),
  post(conversationReview.id, 22, 'The restraint worked better for me on a second reading.', id(1021)),
];
const failureReplies = [
  post(
    conversationFailure.id,
    61,
    'The written description gives us enough to continue the conversation.',
    conversationFailure.firstPost.id,
  ),
];
const accepted = new Map<string, AvailablePost[]>();
const commands = new Map<string, AvailablePost>();
const failedCommands = new Set<string>();
const watching = new Set<string>();

/** Each PageStory mount starts with a stable review state; only explicit commands change it. */
export function resetConversationExamples() {
  accepted.clear();
  commands.clear();
  failedCommands.clear();
  watching.clear();
}

function card(value: Thread, signedIn: boolean, index: number): BoardPageResponse['threads'][number] {
  const author = authors.find((item) => item.id === value.authorId)!;
  return {
    thread: value,
    target: { kind: 'thread', id: value.id, boardId: conversationBoardId },
    authors: {
      thread: { ...author, state: 'available', kind: 'actor', automated: false },
      openingPost: { ...author, state: 'available', kind: 'actor', automated: false },
    },
    media: { state: 'none', images: [] },
    interaction: {
      target: { kind: 'thread', id: value.id },
      counts: index === 3 ? { state: 'unavailable' } : { state: 'as-of', values: { like: 3 }, source },
      viewer: signedIn ? { state: 'current', reaction: null } : { state: 'not-applicable' },
    },
    comments:
      index === 3
        ? { state: 'unavailable' }
        : {
            state: 'current',
            cohort: 'public',
            count: index === 0 ? { kind: 'lower-bound', value: 5 } : { kind: 'exact', value: index === 1 ? 2 : 0 },
            lastActivityAt: index < 2 ? createdAt : null,
            source,
          },
    actions: { reply: signedIn ? 'allowed' : 'sign-in', react: signedIn ? 'allowed' : 'sign-in', share: 'available' },
  };
}

function boardPage(request: Request): BoardPageResponse {
  const signedIn = request.headers.has('authorization');
  const cursor = new URL(request.url).searchParams.get('cursor');
  const sparse = cursor === conversationSparseCursor;
  const continued = cursor === conversationBoardCursor;
  return {
    board,
    pinRevision: '1',
    pinnedThreads: continued || sparse ? [] : [card(conversationReview, signedIn, 1)],
    threads: sparse
      ? []
      : (continued
          ? [conversationDiscussion]
          : [conversationDiscussion, conversationLong, conversationFailure, conversationUntitled]
        ).map((value) => card(value, signedIn, allThreads.indexOf(value))),
    next: sparse ? conversationBoardCursor : continued ? null : conversationSparseCursor,
    rankRefreshedAt: null,
    reactionsAsOf: null,
    viewer: { participation: signedIn ? 'allowed' : 'sign-in' },
    actions: { createThread: signedIn ? 'allowed' : 'sign-in' },
  };
}

function readingPage(value: Thread, request: Request): ReadingPageResponse {
  const signedIn = request.headers.has('authorization');
  const cursor = new URL(request.url).searchParams.get('cursor');
  const replies =
    value.id === conversationDiscussion.id
      ? conversationDiscussionReplies
      : value.id === conversationReview.id
        ? reviewReplies
        : value.id === conversationFailure.id
          ? failureReplies
          : [];
  const currentReplies = [...replies, ...(accepted.get(value.id) ?? [])];
  const page = authoredReadingPage(value, cursor === conversationThreadCursor ? [] : currentReplies, authors);
  page.query.cursor = cursor;
  page.viewer = signedIn ? { kind: 'account', id: 'story-viewer' } : { kind: 'anonymous' };
  page.replies.next = value.id === conversationDiscussion.id && cursor === null ? conversationThreadCursor : null;
  page.conversationActivity =
    value.id === conversationFailure.id
      ? { state: 'withheld' }
      : {
          state: 'current',
          cohort: 'public',
          count:
            value.id === conversationDiscussion.id
              ? { kind: 'lower-bound', value: 5 }
              : { kind: 'exact', value: currentReplies.length },
          lastActivityAt: currentReplies.length ? createdAt : null,
        };
  const operationState: 'available' | 'sign_in_required' = signedIn ? 'available' : 'sign_in_required';
  page.actions = {
    state: 'current',
    retryable: false,
    reply: { state: operationState },
    references: [value.firstPost, ...page.replies.items].map((item, index) => ({
      type: index === 0 ? 'content.thread' : 'content.post',
      id: index === 0 ? value.id : item.id,
      ...(item.availability === 'available' ? { sourceRevisionId: item.revisionId } : {}),
      state: 'current',
      operations: [
        {
          operationId: `${index === 0 ? 'thread' : 'post'}.set_reaction`,
          action: 'reaction:set',
          state: operationState,
        },
        {
          operationId: `${index === 0 ? 'thread' : 'post'}.clear_reaction`,
          action: 'reaction:clear',
          state: operationState,
        },
        ...(index === 0
          ? [
              { operationId: 'thread.watch', action: 'thread:watch', state: operationState },
              { operationId: 'thread.unwatch', action: 'thread:watch', state: operationState },
            ]
          : []),
      ],
    })),
  };
  page.currentness.actions = 'current';
  page.watch = !signedIn
    ? { state: 'sign_in_required' }
    : value.id === conversationFailure.id
      ? { state: 'unavailable', retryable: true }
      : { state: 'current', watching: watching.has(value.id) };
  page.currentness.watch = page.watch.state;
  page.slowMode = {
    state: 'current',
    intervalSeconds: 0,
    retryAt: null,
    nextEligibleAt: null,
    canChange: false,
    exempt: false,
    admissionState: 'ready',
    retryAfterSeconds: 0,
  };
  page.currentness.slowMode = 'current';
  if (value.kind === 'review')
    page.reviewContext = {
      source: {
        threadId: value.id,
        postId: value.firstPost.id,
        revisionId: value.firstPost.availability === 'available' ? value.firstPost.revisionId : null,
      },
      target: {
        state: 'available',
        subject: { id: conversationSubjectId, kind: 'book', label: { value: 'The Little Prince', language: 'en' } },
      },
      citations: {
        state: 'current',
        items: [
          {
            postId: value.firstPost.id,
            sourceRevisionId: value.firstPost.availability === 'available' ? value.firstPost.revisionId : null,
            citation: {
              state: 'available',
              questionId: conversationQuestionId,
              units: 0,
              voteRevision: 3,
              metadata: { state: 'unavailable' },
            },
          },
        ],
      },
    };
  return page;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/boards\/([^/]+)(\/page)?$/,
    story: ({ request, match }) =>
      match?.[1] !== conversationBoardId
        ? undefined
        : match[2]
          ? { status: 200, ...boardPage(request) }
          : { status: 200, board },
  },
  {
    method: 'GET',
    path: /^\/v1\/threads\/([^/]+)(\/reading-page|\/reaction|\/watch)?$/,
    story: ({ request, match }) => {
      const value = allThreads.find((item) => item.id === match?.[1]);
      if (!value) return;
      if (match?.[2] === '/reading-page') return { status: 200, ...readingPage(value, request) };
      if (match?.[2] === '/reaction') return { status: 200, kind: null };
      if (match?.[2] === '/watch')
        return value.id === conversationFailure.id
          ? { status: 503, code: 'dependency_unavailable' }
          : { status: 200, watching: watching.has(value.id) };
      return { status: 200, thread: value };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/posts\/([^/]+)\/location$/,
    story: ({ match }) =>
      [
        ...conversationDiscussionReplies,
        ...reviewReplies,
        ...failureReplies,
        ...Array.from(accepted.values()).flat(),
      ].some((item) => item.id === match?.[1])
        ? { status: 200, cursor: null }
        : undefined,
  },
  {
    method: 'POST',
    path: /^\/v1\/threads\/([^/]+)\/posts$/,
    story: async ({ request, match }): Promise<KernelRecording | undefined> => {
      const value = allThreads.find((item) => item.id === match?.[1]);
      if (!value) return;
      const key = `${value.id}:${request.headers.get('idempotency-key')}`;
      if (value.id === conversationFailure.id && !failedCommands.has(key)) {
        failedCommands.add(key);
        return { status: 503, code: 'dependency_unavailable' };
      }
      if (commands.has(key)) return { status: 200, post: commands.get(key) };
      const body = (await request.json()) as { body: DocumentSnapshot; parentId?: string };
      const reply = {
        ...post(value.id, 300 + commands.size, '', body.parentId ?? null),
        body: body.body,
        authorId: 'story-viewer',
      };
      commands.set(key, reply);
      accepted.set(value.id, [...(accepted.get(value.id) ?? []), reply]);
      return { status: 201, post: reply };
    },
  },
  ...(['PUT', 'DELETE'] as const).map((method): FakeRoute => ({
    method,
    path: /^\/v1\/threads\/([^/]+)\/watch$/,
    story: ({ match }) => {
      const value = allThreads.find((item) => item.id === match?.[1]);
      if (!value) return;
      if (value.id === conversationFailure.id) return { status: 503, code: 'dependency_unavailable' };
      if (method === 'PUT') watching.add(value.id);
      else watching.delete(value.id);
      return { status: 204 };
    },
  })),
];
