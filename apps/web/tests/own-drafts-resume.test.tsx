import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import {
  readSelectedOwnDraft,
  type OwnDraftEntry,
  type OwnDraftIdentity,
  type OwnDraftReader,
  type OwnDraftSelectionRequest,
} from '../src/threads/own-drafts/model';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';

test('explicit selection reads one exact current draft; stale or concealed revisions stay unavailable', async () => {
  const identity: OwnDraftIdentity = {
    accountId, authnEpoch: 2, callerEpoch: 'caller-1', locale: 'en', source: 'content', address: '/drafts',
  };
  const entry: OwnDraftEntry = {
    id: postId, threadId, firstPostId: postId, revisionId, authorId: accountId,
    kind: 'discussion', documentKind: 'opening', title: 'Private draft', savedAt: '2026-10-28T09:42:00.000Z',
    licence: 'LicenseRef-rezics-terms', language: 'en', subjectIds: [], mediaIds: [],
    board: { id: 'board-1', title: 'Board', realmId: null },
    actions: { resume: `/v1/accounts/${accountId}/drafts/${postId}?threadId=${threadId}`, edit: null, publish: null, erase: null },
  };
  const calls: OwnDraftSelectionRequest[] = [];
  let stale = false;
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [entry], next: null }),
    resume: async (request) => {
      calls.push(request);
      return {
        revision: stale ? 'newer-revision' : revisionId,
        post: { id: postId, threadId, body: fromPlainText('Only this chosen body', 'blocks') },
      };
    },
  };

  await reader.list({ accountId }, new AbortController().signal);
  expect(calls).toHaveLength(0);
  const chosen = await readSelectedOwnDraft(reader, identity, entry, new AbortController().signal);
  expect(calls).toEqual([{ accountId, id: postId, threadId }]);
  expect(typeof chosen).not.toBe('string');
  stale = true;
  expect(await readSelectedOwnDraft(reader, identity, entry, new AbortController().signal)).toBe('stale');
  expect(calls).toHaveLength(2);
});
