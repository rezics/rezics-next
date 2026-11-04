import { expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnedCollection } from '../src/settings/preferences';
import { CollectionPrivacyEditor } from '../src/settings/collection-privacy-recovery';

mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/query', () => ({
  sessionQuery: { queryKey: ['session'] },
  exposureQuery: { queryKey: ['exposure'] },
  sessionCsrfToken: () => 'test-token',
  useSession: () => ({ state: 'signed-in', csrfToken: 'test-token' }),
}));
const { CollectionRow } = await import('../src/settings/collection-privacy');
const { SettingsSessionOwner } = await import('../src/settings/settings-session-owner');

const privateCurated: OwnedCollection = {
  id: 'private-curated',
  title: 'Private reading',
  kind: 'curated',
  membershipKind: 'curated',
  visibility: 'private',
  revision: 7,
  allowedVisibilityActions: ['unlisted'],
};
const builtin: OwnedCollection = {
  id: 'builtin-everything',
  title: 'Everything',
  kind: 'builtin',
  membershipKind: 'dynamic',
  builtinKind: 'everything',
  builtin: { kind: 'everything' },
  visibility: 'private',
  revision: null,
  allowedVisibilityActions: [],
};
const io = {
  save: async () => ({ ok: false as const, reason: 'unavailable' as const }),
  read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
};

function markup(collection: OwnedCollection) {
  return renderToStaticMarkup(createElement(CollectionRow, { collection, io }));
}

test('visibility options follow native advice and logical built-ins remain read-only', () => {
  const curated = markup(privateCurated);
  expect(curated).toMatch(/<option[^>]*value="private" selected="">/);
  expect(curated).toMatch(/<option[^>]*value="unlisted">/);
  expect(curated).not.toMatch(/<option[^>]*value="public">/);

  const logical = markup(builtin);
  expect(logical).toContain('disabled=""');
  expect(logical).toMatch(/<option[^>]*value="private" selected="">/);
  expect(logical).not.toMatch(/<option[^>]*value="unlisted">/);
  expect(logical).not.toMatch(/<option[^>]*value="public">/);
});

test('current owner advice remains usable when the retry target already matches', () => {
  const current = { ...privateCurated, visibility: 'public' as const, allowedVisibilityActions: ['private', 'unlisted'] as const };
  const editor = new CollectionPrivacyEditor(current, io);
  expect(editor.hasCurrentUpdateAdvice()).toBe(true);
  editor.receive({ ...current, allowedVisibilityActions: [] });
  expect(editor.hasCurrentUpdateAdvice()).toBe(false);
  editor.dispose();
});

test('a retired viewer cannot restore its old credential after A to B to A', () => {
  const client = new QueryClient();
  const queryKey = ['session'];
  const accountA = { state: 'signed-in', subject: 'account-a', csrfToken: 'test-token' };
  client.setQueryData(queryKey, accountA);
  const owner = new SettingsSessionOwner(client, 'test-token', 'account-a');
  expect(owner.credential()).toBe('test-token');

  client.setQueryData(queryKey, { state: 'signed-in', subject: 'account-b', csrfToken: 'other-token' });
  expect(owner.credential()).toBeNull();
  client.setQueryData(queryKey, accountA);
  expect(owner.credential()).toBeNull();
  client.clear();
});
