import { expect, test } from 'bun:test';
import {
  admittedOwnDraftAction,
  indexOwnDraftPage,
  isOwnDraftCursor,
  ownDraftIdentityKey,
  ownDraftRequestKey,
  type OwnDraftIdentity,
} from '../src/threads/own-drafts/model';
import { resolveNavigation } from '../src/shell/navigation';

import { accountId, postId, row } from './own-drafts-fixture';

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

test('keeps the native opaque cursor length bound in JavaScript code units', () => {
  expect(isOwnDraftCursor(' ')).toBe(true);
  expect(isOwnDraftCursor('x'.repeat(32768))).toBe(true);
  expect(isOwnDraftCursor('')).toBe(false);
  expect(isOwnDraftCursor('x'.repeat(32769))).toBe(false);
});

test('signed-in account navigation opens the exact localized private drafts destination', async () => {
  const { defaultNavigation } = await import('../src/shell/navigation-view');
  const resolved = resolveNavigation(defaultNavigation, { locale: 'ja', pathname: '/ja/drafts' });
  expect(resolved.find((item) => item.id === 'shell.drafts')).toMatchObject({
    path: '/drafts',
    href: '/ja/drafts',
    current: true,
    group: 'personal',
    signedIn: true,
  });
});
