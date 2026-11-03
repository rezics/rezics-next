import type { HomeQuestion, HomeQuestionPage } from '../../features/pages/home-feed-questions';
import type { FeedItem, FeedPage } from '../../features/pages/home-feed-read';
import { discoveryExample } from './search-discovery';
import type { DiscoveryKinds } from '../../search/discovery';
import type { FakeRoute } from '../fake-modules';
import home from '../recorded/home-page.json';
import thread from '../recorded/thread.json';
import collection from '../recorded/library-collection.json';
import sessions from '../recorded/library-continue-progress-sessions.json';

export type HomeFeedStory =
  | 'mixed'
  | 'partial'
  | 'preparing'
  | 'unavailable'
  | 'empty'
  | 'sparse'
  | 'following'
  | 'kinds-unavailable'
  | 'kinds-next'
  | 'space-selection'
  | 'space-unavailable'
  | 'space-identity-changed'
  | 'questions-selection'
  | 'question-lost'
  | 'questions-unavailable'
  | 'questions-next'
  | 'expired-page';
let selected: HomeFeedStory = 'mixed';
let homeActive = false;
let spaceReads = 0;
let continuation: { requests: URL[]; wait: Promise<void>; release: () => void } | undefined;

/** Hold the real fake-route request so the existing Home stories can exercise pending Next. */
export function holdHomeFeedContinuation() {
  continuation?.release();
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const held = {
    requests: [] as URL[],
    wait,
    release: () => {
      resume();
      if (continuation === held) continuation = undefined;
    },
  };
  continuation = held;
  return held;
}

export function selectHomeFeedStory(state: HomeFeedStory = 'mixed', active = true) {
  continuation?.release();
  selected = state;
  spaceReads = 0;
  homeActive = active;
}

/** Illustrative feed envelopes from recorded native owner summaries, NOT native feed acceptance recordings. */
export function homeFeedStoryPage(
  locale = 'en',
  personal = true,
  state: HomeFeedStory = selected,
  cursor?: string,
  kind?: string,
  spaceId?: string,
  ratingQuestionId?: string,
): FeedPage {
  const first = home.reads.r0.body.subjects[0]!;
  const labels = first.labels as Record<string, string>;
  const label = { value: labels[locale] ?? labels.en!, language: labels[locale] ? locale : 'en' };
  const session = sessions.progressSessions[0]!;
  const continuedSummary = { ...session.subject, label };
  const discovery: FeedItem = {
    id: `semantic:${first.id}`,
    source: 'discovery',
    key: { owner: 'semantic', kind: first.type, route: 4660, id: first.id },
    occurredAt: null,
    summary: { id: first.id, type: first.type, types: [first.type], label, creativeWork: true, cover: null },
    destination: { kind: 'subject', id: first.id, title: label.value },
  };
  const followed: FeedItem = {
    id: `activity:${thread.thread.id}`,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: thread.thread.route, id: thread.thread.id },
    occurredAt: thread.thread.createdAt,
    summary: {
      id: thread.thread.id,
      kind: 'discussion',
      title: thread.thread.title,
      createdAt: thread.thread.createdAt,
    },
    destination: { kind: 'thread', id: thread.thread.id, title: thread.thread.title },
  };
  const continued: FeedItem = {
    id: `continue:${session.subjectId}`,
    source: 'continue',
    key: { owner: 'semantic', kind: session.subject.type, route: 4660, id: session.subjectId },
    occurredAt: session.startedAt,
    summary: continuedSummary,
    destination: { kind: 'subject', id: session.subjectId, title: label.value },
    continue: {
      subjectId: session.subjectId,
      state: null,
      lastActivityAt: session.startedAt,
      subject: continuedSummary,
      activeProgressSession: { ...session, mode: 'completed_units', state: 'active' },
    },
  };
  const curated: FeedItem = {
    id: `activity:${collection.collection.id}`,
    source: 'following',
    key: { owner: 'library', kind: 'collection', route: 4660, id: collection.collection.id },
    occurredAt: collection.collection.updatedAt,
    summary: {
      id: collection.collection.id,
      title: collection.collection.title,
      description: collection.collection.description,
    },
    destination: { kind: 'collection', id: collection.collection.id, title: collection.collection.title },
  };
  const reviewId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';
  const reviewed: FeedItem = {
    id: `activity:${reviewId}`,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: thread.thread.route, id: reviewId },
    occurredAt: thread.thread.createdAt,
    summary: {
      id: reviewId,
      kind: 'review',
      title: 'A careful reread',
      createdAt: thread.thread.createdAt,
    },
    destination: { kind: 'thread', id: reviewId, title: 'A careful reread' },
  };
  // Explicit selected wire examples; this fake is not the native candidate-selection implementation.
  const selectedItems =
    kind === first.type
      ? state === 'following' || cursor
        ? []
        : personal
          ? [discovery, continued]
          : [discovery]
      : kind === 'collection'
        ? personal
          ? [curated]
          : []
        : kind === 'thread'
          ? personal
            ? [followed, reviewed]
            : []
          : [];
  const items =
    kind !== undefined
      ? selectedItems
      : !personal
        ? [discovery]
        : state === 'following'
          ? [followed, reviewed, curated]
          : cursor
            ? [curated]
            : [discovery, followed, continued];
  // Question examples contain only reviewed Subjects. They do not claim native witness proof.
  const questionItems =
    ratingQuestionId === homeQuestionStoryPage().ratingQuestions[0]!.id &&
    (kind === undefined || kind === first.type) &&
    state !== 'following' &&
    !cursor
      ? personal
        ? [discovery, continued]
        : [discovery]
      : [];
  return {
    feedItems:
      state === 'empty' || state === 'preparing' || state === 'unavailable' || (state === 'sparse' && !cursor)
        ? []
        : ratingQuestionId !== undefined
          ? questionItems
          : state === 'partial' && personal
            ? kind === undefined || kind === first.type
              ? [discovery, continued]
              : []
            : items,
    next:
      !cursor &&
      (state === 'sparse' ||
        ratingQuestionId !== undefined ||
        kind !== undefined ||
        ((state === 'mixed' || spaceId !== undefined) && personal))
        ? 'illustrative-signed-frontier'
        : null,
    asOf: '2026-11-01T00:00:00.000Z',
    sources: {
      discovery:
        state === 'following'
          ? 'not_requested'
          : state === 'unavailable'
            ? 'unavailable'
            : state === 'preparing'
              ? 'preparing'
              : 'ready',
      following: !personal
        ? 'not_requested'
        : state === 'partial' || state === 'unavailable'
          ? 'unavailable'
          : state === 'preparing'
            ? 'preparing'
            : 'ready',
      continue:
        !personal || state === 'following'
          ? 'not_requested'
          : state === 'unavailable'
            ? 'unavailable'
            : state === 'preparing'
              ? 'preparing'
              : 'ready',
    },
  };
}

/** Bounded Home-only illustrative metadata using the existing native-kind example identities/labels. */
export function homeKindStoryPage(cursor?: string): DiscoveryKinds {
  const book = discoveryExample.kinds.values.find((kind) => kind.id === 'schema:Book')!;
  const account = discoveryExample.kinds.values.find((kind) => kind.id === 'account')!;
  return cursor ? { values: [account], next: null } : { values: [book], next: 'illustrative-kind-frontier' };
}

/** Illustrative native-format Space point envelope; no membership or continuity certificate. */
export const homeStorySpace = {
  spaceId: '01a1a000-0000-7000-8000-000000000811',
  realmId: '01a1a000-0000-7000-8000-000000000812',
  headRevisionId: '01a1a000-0000-7000-8000-000000000813',
  state: 'active' as const,
  address: 'home-reading-room',
  title: 'Home Reading Room',
  summary: 'An illustrative Space for the Home exact-address journey.',
  predecessor: null,
  creator: '01a1a000-0000-7000-8000-000000000814',
  author: '01a1a000-0000-7000-8000-000000000814',
  createdAt: '2026-11-01T00:00:00.000Z',
  revisionCreatedAt: '2026-11-01T00:00:00.000Z',
};

/** Native-format illustrative metadata only, isolated to the Home route. */
export function homeQuestionStoryPage(cursor?: string): HomeQuestionPage {
  const question: HomeQuestion = {
    id: cursor ? '00000000-0000-7000-8000-000000000002' : '00000000-0000-7000-8000-000000000001',
    revision: 1,
    label: cursor ? 'Character portrayal' : 'Overall impression',
    grain: cursor ? 'character' : 'work',
    scale: { min: 0, max: 100, displayStep: 5 },
  };
  return { ratingQuestions: [question], next: cursor ? null : 'illustrative-question-frontier' };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/rating-questions',
    story: ({ request }) => {
      if (!homeActive) return;
      if (selected === 'questions-unavailable') return { status: 503, code: 'dependency_unavailable' };
      const page = homeQuestionStoryPage(new URL(request.url).searchParams.get('cursor') ?? undefined);
      return { status: 200, ...page };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/rating-questions\/([^/]+)$/,
    story: ({ match }) => {
      if (!homeActive) return;
      if (selected === 'question-lost') return { status: 404, code: 'not_found' };
      const question = [homeQuestionStoryPage(), homeQuestionStoryPage('illustrative-question-frontier')]
        .flatMap((page) => page.ratingQuestions)
        .find((question) => question.id === match?.[1]);
      return question ? { status: 200, ...question } : { status: 404, code: 'not_found' };
    },
  },

  {
    method: 'GET',
    path: '/v1/spaceAddresses/home-reading-room',
    story: () => (homeActive ? { status: 200, spaceId: homeStorySpace.spaceId } : undefined),
  },
  {
    method: 'GET',
    path: `/v1/spaces/${homeStorySpace.spaceId}`,
    story: () => {
      if (!homeActive) return;
      spaceReads++;
      const space = {
        ...homeStorySpace,
        realmId:
          selected === 'space-unavailable'
            ? null
            : selected === 'space-identity-changed' && spaceReads > 1
              ? '01a1a000-0000-7000-8000-000000000815'
              : homeStorySpace.realmId,
      };
      return { status: 200, space, community: null };
    },
  },
  {
    method: 'POST',
    path: '/v1/subjects:search',
    story: async ({ request }) => {
      if (!homeActive) return;
      const body = (await request.json()) as {
        representation?: string;
        limit?: number;
        kindPage?: { cursor?: string };
      };
      if (
        body.representation !== 'discovery-v1' ||
        (body.limit !== 1 && body.kindPage?.cursor !== 'illustrative-kind-frontier')
      )
        return;
      if (selected === 'kinds-unavailable') return { status: 503, code: 'dependency_unavailable' };
      const kinds = homeKindStoryPage(body.kindPage?.cursor);
      return body.kindPage?.cursor
        ? { status: 200, kinds, as_of: '2026-11-01T00:00:00Z' }
        : {
            status: 200,
            hits: [],
            kinds: { ...kinds, next: selected === 'kinds-next' ? kinds.next : null },
            next: null,
            as_of: '2026-11-01T00:00:00Z',
          };
    },
  },
  {
    method: 'GET',
    path: '/v1/feedItems',
    story: async ({ request }) => {
      const url = new URL(request.url);
      const held = continuation;
      if (held && url.searchParams.has('cursor')) {
        held.requests.push(url);
        await held.wait;
      }
      if (selected === 'expired-page' && url.searchParams.has('cursor')) return { status: 409, code: 'invalid_cursor' };
      const locale = request.headers.get('accept-language')?.split(',')[0] ?? 'en';
      const personal = request.headers.has('authorization');
      const state = url.searchParams.get('stream') === 'following' ? 'following' : selected;
      return {
        status: 200,
        ...homeFeedStoryPage(
          locale,
          personal,
          state,
          url.searchParams.get('cursor') ?? undefined,
          url.searchParams.get('kind') ?? undefined,
          url.searchParams.get('spaceId') ?? undefined,
          url.searchParams.get('ratingQuestionId') ?? undefined,
        ),
      };
    },
  },
];
