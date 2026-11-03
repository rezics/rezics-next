import recorded from '../recorded/library-collection-members.json';
import { subjectOf } from '../../library/reads';
import type { PublicationPage, PublicationResult } from '../../library/collection-publication';
import type { FakeRoute } from '../fake-modules';

/** Consumer render examples from recorded summaries, not a native ready/empty/publication provider. */
export const publicationStoryIds = {
  ready: 'publication-example',
  denied: 'publication-denied',
  stale: 'publication-stale',
  unavailable: 'publication-unavailable',
  retry: 'publication-retry',
} as const;

export const publicationExample: PublicationPage = {
  viewer: { subject: 'story-viewer', csrfToken: 'story-csrf' },
  address: { id: publicationStoryIds.ready },
  source: {
    state: 'ready',
    revision: 7,
    page: {
      id: publicationStoryIds.ready,
      title: 'Selected reading',
      builtinKind: undefined,
      curatorAccountId: 'story-viewer',
      revision: 7,
      description: null,
      curator: null,
      members: recorded.members.map((member) => ({ subjectId: member.subjectId, subject: subjectOf(member.subject) })),
      next: 'another-native-page',
      preparing: false,
      unavailable: false,
      retryAfterMs: 1000,
    },
  },
};

export const publicationRefusal = (reason: Extract<PublicationResult, { ok: false }>['reason']): PublicationResult => ({
  ok: false,
  reason,
});

const readyIds = new Set<string>(Object.values(publicationStoryIds));
const publishStatus: Record<string, number> = {
  [publicationStoryIds.ready]: 503,
  [publicationStoryIds.denied]: 403,
  [publicationStoryIds.stale]: 409,
  [publicationStoryIds.retry]: 500,
};

function publicationCollection(id: string) {
  return {
    status: 200,
    collection: {
      id,
      curatorAccountId: 'story-viewer',
      title: 'Selected reading',
      description: null,
      membershipKind: 'dynamic',
      revision: 7,
    },
  };
}

function publicationMembers() {
  return {
    status: 200,
    next: 'another-native-page',
    members: recorded.members.map((member) => ({
      kind: 'dynamic',
      subjectId: member.subjectId,
      subject: member.subject,
    })),
  };
}

/** Story kernel refusals only. No complete publication body or native generation. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/collections\/(publication-(?:example|denied|stale|unavailable|retry))(\/members)?$/,
    story: ({ match }) => {
      const id = match?.[1];
      if (!id || !readyIds.has(id)) return;
      if (match[2]) {
        if (id === publicationStoryIds.unavailable) return { status: 503, code: 'dependency_unavailable' };
        return publicationMembers();
      }
      return publicationCollection(id);
    },
  },
  {
    method: 'POST',
    path: /^\/v1\/collections\/(publication-(?:example|denied|stale|retry)):publishSelected$/,
    story: ({ match }) => {
      const status = match?.[1] ? publishStatus[match[1]] : undefined;
      return status ? { status } : undefined;
    },
  },
];
