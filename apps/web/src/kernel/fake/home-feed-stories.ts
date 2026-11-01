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
  | 'following'
  | 'kinds-unavailable'
  | 'kinds-next';
let selected: HomeFeedStory = 'mixed';
let homeActive = false;
export function selectHomeFeedStory(state: HomeFeedStory = 'mixed', active = true) {
  selected = state;
  homeActive = active;
}

/** Illustrative feed envelopes from recorded native owner summaries, NOT native feed acceptance recordings. */
export function homeFeedStoryPage(
  locale = 'en',
  personal = true,
  state: HomeFeedStory = selected,
  cursor?: string,
  kind?: string,
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
  // Explicit selected wire examples; this fake is not the native candidate-selection implementation.
  const selectedItems =
    kind === first.type ? (state === 'following' || cursor ? [] : personal ? [discovery, continued] : [discovery]) : [];
  const items =
    kind !== undefined
      ? selectedItems
      : !personal
        ? [discovery]
        : state === 'following'
          ? [followed, curated]
          : cursor
            ? [curated]
            : [discovery, followed, continued];
  return {
    feedItems:
      state === 'empty' || state === 'preparing' || state === 'unavailable'
        ? []
        : state === 'partial' && personal
          ? kind === undefined || kind === first.type
            ? [discovery, continued]
            : []
          : items,
    next: !cursor && (kind !== undefined || (state === 'mixed' && personal)) ? 'illustrative-signed-frontier' : null,
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

export const routes: FakeRoute[] = [
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
    story: ({ request }) => {
      const url = new URL(request.url);
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
        ),
      };
    },
  },
];
