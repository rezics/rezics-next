import type { KernelClient } from '@rezics/client';
import type { ExactRevision, ExactRevisionState } from '../../threads/exact-revision';

export const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
// Constructed native DTO examples, not a recording or proof of native disclosure.
export const selected: ExactRevision = {
  id: id(1),
  threadId: id(2),
  revisionId: id(3),
  authorId: id(90),
  boardId: id(30),
  route: 0,
  parentId: null,
  availability: 'available',
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-10-30T12:00:00Z',
  revisedAt: null,
  sha256: '0'.repeat(64),
  mediaIds: [],
  licence: 'CC-BY-SA-4.0',
  subjectIds: [id(20)],
  voteCitation: { questionId: id(40), units: 14, revision: 2 },
  body: {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'recorded-paragraph' },
          content: [{ type: 'text', text: 'The original edition leaves room for the reader to pause.' }],
        },
      ],
    },
  },
};
export const later: ExactRevision = {
  ...selected,
  revisionId: id(4),
  licence: 'CC-BY-4.0',
  subjectIds: [id(21)],
  revisedAt: '2026-10-31T12:00:00Z',
  voteCitation: { questionId: id(40), units: 8, revision: 3 },
  body: {
    ...selected.body,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'recorded-paragraph' },
          content: [{ type: 'text', text: 'The later edition makes the ending more explicit.' }],
        },
      ],
    },
  },
};
type ThreadResponse = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['threads']>['get']>>['data']>;
export const current: ThreadResponse = {
  thread: {
    id: selected.threadId,
    route: selected.route,
    authorId: selected.authorId,
    kind: 'review',
    title: 'Reading the quiet ending',
    licence: later.licence,
    subjectIds: [...later.subjectIds],
    boardId: selected.boardId,
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt: selected.createdAt,
    firstPost: later,
  },
};
export const identity = { postId: selected.id, revisionId: selected.revisionId };
export const ready: Extract<ExactRevisionState, { state: 'ready' }> = {
  state: 'ready',
  revision: selected,
  thread: { id: current.thread.id, title: current.thread.title, differentHead: false },
  authors: {},
  mentions: {},
  documentMedia: { kind: 'unavailable' },
  now: '2026-10-31T13:00:00Z',
};
export const exactRevisionViewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
  desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
};
