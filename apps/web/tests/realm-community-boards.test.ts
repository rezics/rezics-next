import { expect, test } from 'bun:test';
import { presentRealmBoardRecent } from '../src/community/realm-community/recent';
import {
  isRealmMembershipCompletion,
  isRealmPublicationCompletion,
  type RealmCompletion,
  type RealmMembershipCompletion,
  type RealmPublicationCompletion,
} from '../src/community/realm-community/completion';

const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000050';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000051';

function currentRecent(board = boardId) {
  return {
    state: 'current' as const,
    complete: true,
    threads: [
      {
        thread: { id: threadId, title: 'Ordinary thread', firstPost: { availability: 'available' } },
        target: { kind: 'thread' as const, id: threadId, boardId: board },
        comments: {
          state: 'current' as const,
          cohort: 'public' as const,
          count: { kind: 'exact' as const, value: 1 },
          lastActivityAt: '2026-11-01T00:00:00Z',
          source: { epoch: 1, position: '16' },
        },
      },
    ],
  };
}

test('native recent discussion prefixes keep exact destinations and never invent an empty page', () => {
  expect(presentRealmBoardRecent(currentRecent(), boardId)).toEqual({
    state: 'current',
    complete: true,
    threads: [{ id: threadId, title: 'Ordinary thread', comments: { state: 'current', kind: 'exact', value: 1 } }],
  });
  expect(presentRealmBoardRecent(undefined, boardId)).toEqual({ state: 'unavailable' });
  expect(presentRealmBoardRecent({ state: 'unavailable' }, boardId)).toEqual({ state: 'unavailable' });
  expect(presentRealmBoardRecent(currentRecent('0192f3a0-6c1e-7b2a-9d4e-000000000099'), boardId)).toEqual({
    state: 'unavailable',
  });
  const overflow = {
    ...currentRecent(),
    threads: [
      ...currentRecent().threads,
      ...currentRecent().threads,
      ...currentRecent().threads,
      ...currentRecent().threads,
    ],
  };
  expect(presentRealmBoardRecent(overflow, boardId)).toEqual({ state: 'unavailable' });
});

test('membership completion stays with the header host; only publication receipts restore a shelf region', () => {
  const membership: RealmMembershipCompletion = {
    realmId: boardId,
    action: 'join',
    membership: 'member',
    current: () => true,
    focusEligible: () => true,
  };
  const publication: RealmPublicationCompletion = {
    realmId: boardId,
    subjectId: threadId,
    action: 'publish',
    head: threadId,
    current: () => true,
    focusEligible: () => true,
  };
  const other: RealmCompletion = { realmId: boardId, current: () => true, focusEligible: () => true };
  expect(isRealmMembershipCompletion(membership)).toBe(true);
  expect(isRealmPublicationCompletion(membership)).toBe(false);
  expect(isRealmPublicationCompletion(publication)).toBe(true);
  expect(isRealmMembershipCompletion(publication)).toBe(false);
  expect(isRealmPublicationCompletion(other)).toBe(false);
  expect(isRealmMembershipCompletion(other)).toBe(false);
});
