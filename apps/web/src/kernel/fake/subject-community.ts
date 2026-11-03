import { planReads, platformRegistry, type CompositionDocument, type PageContinuation } from '@rezics/composition';
import demoFixtures from '../fixtures.json';
import type { SubjectPageData } from '../../features/pages/subject';
import type { Fixtures, KernelRecording } from '../fake';
import { fromPlainText } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import type { NativeCommunityThread, CommunityKind } from '../../features/pages/subject-community';
import { GLOBAL } from '../../features/pages/subject-ratings';
import type { FakeRoute } from '../fake-modules';
import { isRecord } from './languages';
import { subjectSourcesPage } from './subject-sources';

export const communitySubject = { id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4', label: 'The Little Prince' };
export const communityCharacter = { id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e5', label: 'The fox' };

export function isCommunityPageTarget(target: unknown): boolean {
  return (
    isRecord(target) &&
    target.subject === communitySubject.id &&
    !target.realm &&
    (target.view === undefined ||
      target.view === 'overview' ||
      target.view === 'reviews' ||
      target.view === 'discussion')
  );
}

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

export function communityThread(
  kind: CommunityKind,
  later = false,
  subject: typeof communitySubject = communitySubject,
): NativeCommunityThread {
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
    subjectIds: [subject.id],
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
      subjectIds: [subject.id],
      visibility: 'published',
      securityRevision: '1',
      createdAt,
      revisedAt: null,
      mediaIds: [],
      voteCitation:
        kind === 'review' ? { questionId: id('85'), units: 14, revision: 2 } : null,
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
    reactions: { upvote: 3, like: 2, insightful: 1 },
    viewerReaction: 'like',
  };
}

type Board = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['boards']>['get']>>['data']>['board'];
export function communityBoard(kind: CommunityKind): Board {
  return {
    id: id(kind === 'review' ? '80' : '90'),
    realmId: null,
    community: null,
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
  const subject = [communitySubject, communityCharacter].find(({ id }) => id === match?.[1]);
  if (!subject || query.get('place') !== GLOBAL) return;
  const kind = query.get('kind');
  if (kind !== 'review' && kind !== 'discussion') return;
  const cursor = query.get('cursor');
  if (cursor !== null && cursor !== 'community-next') return { status: 400 };
  return {
    status: 200,
    threads: [communityThread(kind, cursor !== null, subject)],
    next: cursor ? null : 'community-next',
  };
};
const boardRead: FakeRoute['story'] = ({ match }) => {
  for (const kind of ['review', 'discussion'] as const) {
    const board = communityBoard(kind);
    if (match?.[1] === board.id) return { status: 200, board };
  }
};
/** The shared page renderer receives the same existing story DTOs through composition leaves. */
const composedPage: FakeRoute['story'] = async ({ request }) => {
  const input = (await request.clone().json()) as {
    target?: { subject?: string; realm?: string };
    continuation?: PageContinuation;
  };
  if (!isCommunityPageTarget(input.target) || subjectSourcesPage(input)) return;
  const { pageRead } = await import('../fake');
  const response = await pageRead(demoFixtures as unknown as Fixtures, request.clone() as Request);
  const page = (await response.json()) as SubjectPageData;
  if (response.status !== 200) return { status: response.status, __responseBody: page };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: communitySubject.id,
    ...(input.continuation ? { continuation: input.continuation } : {}),
  });
  const selected = input.continuation ? plan.nodes[input.continuation.node] : undefined;
  for (const [key, read] of Object.entries(plan.reads)) {
    if (
      selected &&
      key !== selected &&
      (read.kind === 'links' || read.kind === 'relations' || read.kind === 'subjectThreads')
    ) {
      page.reads[key] = { status: 204, body: {} };
    } else if (read.kind === 'subjectThreads') {
      page.reads[key] =
        read.cursor && read.cursor !== 'community-next'
          ? { status: 400, body: { code: 'invalid_cursor' } }
          : {
              status: 200,
              body: {
                threads: [communityThread(read.threadKind, !!read.cursor)],
                next: read.cursor ? null : 'community-next',
              },
            };
    }
  }
  return {
    status: 200,
    ...page,
    ...(input.continuation ? { continuation: input.continuation } : {}),
  } as KernelRecording;
};

export const routes: FakeRoute[] = [
  { method: 'POST', path: '/v1/pages:read', story: composedPage, fixture: composedPage },
  { method: 'GET', path: /^\/v1\/subjects\/([^/]+)\/threads$/, story: subjectThreads, fixture: subjectThreads },
  { method: 'GET', path: /^\/v1\/boards\/([^/]+)$/, story: boardRead, fixture: boardRead },
];
