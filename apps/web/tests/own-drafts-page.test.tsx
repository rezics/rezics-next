import { expect, test } from 'bun:test';
import {
  admittedOwnDraftAction,
  indexOwnDraftPage,
  ownDraftIdentityKey,
  ownDraftRequestKey,
  type OwnDraftEntry,
  type OwnDraftIdentity,
} from '../src/threads/own-drafts/model';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';

function row(overrides: Partial<OwnDraftEntry> = {}): OwnDraftEntry {
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

test('indexes one bounded metadata page without a body and rejects duplicate identities', () => {
  const rows = Array.from({ length: 20 }, (_, index) => row({ id: `post-${index}` }));
  const page = indexOwnDraftPage({
    state: 'ready',
    viewer: { accountId, authnEpoch: 2 },
    drafts: rows,
    next: 'opaque',
  });
  expect(page.rows).toHaveLength(20);
  expect(page.byId.get('post-19')).toBe(rows[19]);
  expect('body' in page.rows[0]!).toBe(false);
  expect(() =>
    indexOwnDraftPage({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [row(), row()], next: null }),
  ).toThrow();
  expect(() =>
    indexOwnDraftPage({
      state: 'ready',
      viewer: { accountId, authnEpoch: 2 },
      drafts: [...rows, row({ id: 'post-20' })],
      next: null,
    }),
  ).toThrow();
});

test('admits only the exact native action path for this account and selected draft', () => {
  const draft = row();
  expect(admittedOwnDraftAction(draft, accountId, 'resume')).toBe(draft.actions.resume);
  expect(
    admittedOwnDraftAction(
      { ...draft, actions: { ...draft.actions, erase: 'https://other.invalid/v1/posts/3' } },
      accountId,
      'erase',
    ),
  ).toBeNull();
  expect(
    admittedOwnDraftAction(
      { ...draft, actions: { ...draft.actions, resume: `/v1/accounts/${accountId}/drafts/${postId}?threadId=wrong` } },
      accountId,
      'resume',
    ),
  ).toBeNull();
  expect(
    admittedOwnDraftAction({ ...draft, actions: { ...draft.actions, publish: null } }, accountId, 'publish'),
  ).toBeNull();
});

test('binds the in-memory page address to account, credentials, locale, source and cursor', () => {
  const identity: OwnDraftIdentity = {
    accountId,
    authnEpoch: 2,
    callerEpoch: 'caller-1',
    locale: 'en',
    source: 'content',
    address: '/drafts',
  };
  const key = ownDraftIdentityKey(identity);
  expect(ownDraftRequestKey(key, null)).not.toBe(ownDraftRequestKey(key, 'opaque-cursor'));
  expect(ownDraftIdentityKey({ ...identity, callerEpoch: 'caller-2' })).not.toBe(key);
  expect(ownDraftIdentityKey({ ...identity, accountId: 'other-account' })).not.toBe(key);
  expect(ownDraftIdentityKey({ ...identity, locale: 'ja' })).not.toBe(key);
});
