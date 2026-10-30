import recorded from '../recorded/library-collection-members.json';
import { subjectOf } from '../../library/reads';
import type { PublicationPage, PublicationResult } from '../../library/collection-publication';

/** Consumer render examples from recorded summaries, not a native ready/empty/publication provider. No HTTP routes. */
export const publicationExample: PublicationPage = {
  viewer: { subject: 'story-viewer', csrfToken: 'story-csrf' },
  address: { id: 'publication-example' },
  source: {
    state: 'ready',
    revision: 7,
    page: {
      id: 'publication-example',
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
