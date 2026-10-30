import { fromPlainText } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import type { NativeCommunityThread, CommunityKind } from '../../features/pages/subject-community';
import { GLOBAL } from '../../features/pages/subject-ratings';
import type { FakeRoute } from '../fake-modules';

export const communitySubject = { id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4', label: 'The Little Prince' };
export const communityAuthor = {
  id: '01a17a3a-20f5-72aa-9f14-f4cc56678188',
  kind: 'actor',
  handle: 'mira',
  displayName: 'Mira Okabe',
  state: 'active',
  automated: false,
  operatorId: null,
} as const;
const id = (suffix: string) => `01a1a000-0000-7000-8000-0000000000${suffix}`;

export function communityThread(kind: CommunityKind, later = false): NativeCommunityThread {
  const threadId = id(kind === 'review' ? (later ? '84' : '81') : later ? '94' : '91');
  const boardId = id(kind === 'review' ? '80' : '90');
  const createdAt = '2026-10-24T00:00:00.000Z';
  return {
    id: threadId,
    route: 1,
    authorId: communityAuthor.id,
    kind,
    boardId,
    title:
      kind === 'review'
        ? later
          ? 'Reading it again'
          : 'A small book with lasting questions'
        : later
          ? 'The final meeting'
          : 'What does the fox teach the prince?',
    subjectIds: [communitySubject.id],
    licence: 'MIT',
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt,
    firstPost: {
      id: id(kind === 'review' ? '82' : '92'),
      threadId,
      route: 1,
      authorId: communityAuthor.id,
      boardId,
      parentId: null,
      licence: 'MIT',
      subjectIds: [],
      visibility: 'published',
      securityRevision: '1',
      createdAt,
      revisedAt: null,
      mediaIds: [],
      voteCitation: null,
      revisionId: id(kind === 'review' ? '83' : '93'),
      body: fromPlainText(
        kind === 'review'
          ? 'The desert journey leaves room for tenderness and responsibility.'
          : 'The conversation about friendship changes the meaning of the journey.',
        'blocks',
      ),
      sha256: 'a'.repeat(64),
      availability: 'available',
    },
  };
}

type Board = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['boards']>['get']>>['data']>['board'];
export function communityBoard(kind: CommunityKind): Board {
  return {
    id: id(kind === 'review' ? '80' : '90'),
    realmId: null,
    route: 1,
    title: kind === 'review' ? 'Public book reviews' : 'Public book discussions',
    purpose: kind === 'review' ? 'reviews' : 'discussion',
    visibility: 'published',
    availability: 'available',
    securityRevision: '1',
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

const subjectThreads: FakeRoute['story'] = ({ request, match }) => {
  const query = new URL(request.url).searchParams;
  if (match?.[1] !== communitySubject.id || query.get('place') !== GLOBAL) return;
  const kind = query.get('kind');
  if (kind !== 'review' && kind !== 'discussion') return;
  const cursor = query.get('cursor');
  if (cursor !== null && cursor !== 'community-next') return { status: 400 };
  return { status: 200, threads: [communityThread(kind, cursor !== null)], next: cursor ? null : 'community-next' };
};
const boardRead: FakeRoute['story'] = ({ match }) => {
  for (const kind of ['review', 'discussion'] as const) {
    const board = communityBoard(kind);
    if (match?.[1] === board.id) return { status: 200, board };
  }
};
export const routes: FakeRoute[] = [
  { method: 'GET', path: /^\/v1\/subjects\/([^/]+)\/threads$/, story: subjectThreads, fixture: subjectThreads },
  { method: 'GET', path: /^\/v1\/boards\/([^/]+)$/, story: boardRead, fixture: boardRead },
];
