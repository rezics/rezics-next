import type { OwnDraftEntry, OwnDraftIdentity } from '../src/threads/own-drafts/model';

export const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
export const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
export const identity: OwnDraftIdentity = {
  accountId,
  authnEpoch: 2,
  callerEpoch: 'caller-1',
  locale: 'en',
  source: 'content',
  address: '/drafts',
};
export function row(overrides: Partial<OwnDraftEntry> = {}): OwnDraftEntry {
  return {
    id: postId,
    threadId,
    firstPostId: postId,
    revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
    authorId: accountId,
    kind: 'discussion',
    documentKind: 'opening',
    title: 'A bounded server draft',
    savedAt: '2026-10-28T09:42:00.000Z',
    licence: 'LicenseRef-rezics-terms',
    language: 'en',
    subjectIds: [],
    mediaIds: [],
    board: { id: 'board-1', title: 'Board', realmId: null },
    actions: {
      resume: `/v1/accounts/${accountId}/drafts/${postId}?threadId=${threadId}`,
      edit: `/v1/posts/${postId}/revisions`,
      publish: `/v1/posts/${postId}/revisions`,
      erase: `/v1/posts/${postId}`,
    },
    ...overrides,
  };
}
