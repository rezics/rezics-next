import { expect, test } from 'bun:test';
import { admittedOwnDraftAction } from '../src/threads/own-drafts/model';
import { accountId, row } from './own-drafts-fixture';

test('native command advice belongs to the selected author, resource and revision', () => {
  const entry = row();
  for (const action of ['edit', 'publish', 'erase'] as const) {
    expect(admittedOwnDraftAction(entry, accountId, action)).toBe(entry.actions[action]);
    for (const replacement of [
      { ...entry, authorId: 'other-account' },
      { ...entry, revisionId: '' },
      { ...entry, id: '../another-post' },
      { ...entry, threadId: 'wrong-thread' },
      { ...entry, actions: { ...entry.actions, [action]: null } },
      { ...entry, actions: { ...entry.actions, [action]: `${entry.actions[action]}#ignored` } },
      { ...entry, actions: { ...entry.actions, [action]: `https://kernel.invalid${entry.actions[action]}` } },
    ])
      expect(admittedOwnDraftAction(replacement, accountId, action)).toBeNull();
  }
});
