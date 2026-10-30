import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  emptyRecent,
  localChange,
  restoreRecent,
  savedRecent,
  RECENT_STORAGE,
  RecentHistoryView,
} from '../src/search/recent';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../src/search/header-search/state';
import { m } from '../src/paraglide/messages.js';

const now = new Date('2026-10-30T12:00:00Z');
test('the visible shared Search input consumes its real recent section and navigation without an extra shell or invented trends', () => {
  const recent = localChange(
    emptyRecent(),
    { kind: 'use', entry: { kind: 'query', text: 'A book & its author', languages: ['en'] } },
    false,
    now,
  );
  const markup = renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'shared-search',
      state: reduceHeaderSearchState(initialHeaderSearchState(), { type: 'open-phone' }),
      locale: 'en',
      region: null,
      recent: createElement(RecentHistoryView, { entries: recent.entries, status: 'local', onRemove() {} }),
    }),
  );
  expect(markup.match(/role="combobox"/g)).toHaveLength(1);
  expect(markup).toContain('action="/en/search"');
  expect(markup).toContain('/en/search?q=A%20book%20%26%20its%20author');
  expect(markup).toContain('/en/search/history');
  expect(markup).toContain(m.search_history_remove({ name: 'A book &amp; its author' }));
  expect(markup).not.toContain('Trending');
});
test('local first history is bounded, expires and never uploads anonymous history into an account queue', () => {
  let anonymous = emptyRecent();
  for (let n = 0; n < 105; n++)
    anonymous = localChange(anonymous, { kind: 'use', entry: { kind: 'query', text: `query ${n}` } }, false, now);
  expect(anonymous.entries).toHaveLength(100);
  expect(anonymous.pending).toEqual([]);
  const storage = new Map([[RECENT_STORAGE + 'anonymous', savedRecent(anonymous)]]);
  expect(restoreRecent(storage.get(RECENT_STORAGE + 'alice') ?? null, now.getTime())).toEqual(emptyRecent());
  expect(restoreRecent(savedRecent(anonymous), now.getTime() + 91 * 86400000).entries).toEqual([]);
  const removed = localChange(anonymous, { kind: 'remove', id: anonymous.entries[0]!.id }, false, now);
  expect(removed.entries).toHaveLength(99);
  expect(localChange(removed, { kind: 'clear' }, false, now).entries).toEqual([]);
});
test('account offline remove and clear keep their actual observed revision and stable receipt identity', () => {
  const state = localChange(
    { ...emptyRecent(), revision: 7 },
    { kind: 'use', entry: { kind: 'query', text: 'mine' } },
    false,
    now,
  );
  state.entries[0]!.id = '019f0000-0000-7000-8000-734100000001';
  const removed = localChange(state, { kind: 'remove', id: state.entries[0]!.id }, true, now);
  const restored = restoreRecent(savedRecent(removed), now.getTime());
  expect(restored.revision).toBe(7);
  expect(restored.pending[0]).toEqual(removed.pending[0]);
  expect(localChange(restored, { kind: 'clear' }, true, now).pending[1]?.change.kind).toBe('clear');
});
test('unavailable current scopes lose cached private names, avatars and clickable fallbacks', () => {
  const scope = {
    id: '019f0000-0000-7000-8000-734100000001',
    entry: {
      kind: 'scope' as const,
      scope: { kind: 'collection' as const, id: '019f0000-0000-7000-8000-734100000002' },
    },
    revision: 2,
    lastUsed: now.toISOString(),
    display: { name: 'Private retained title', href: '/collections/private', avatar: null },
  };
  const stored = savedRecent({ revision: 2, entries: [scope], pending: [] });
  expect(stored).not.toContain('Private retained title');
  const state = restoreRecent(stored, now.getTime());
  const markup = renderToStaticMarkup(
    createElement(RecentHistoryView, { entries: state.entries, status: 'ready', history: true, onRemove() {} }),
  );
  expect(markup).toContain(m.search_history_unavailable());
  expect(markup).not.toContain('href=');
  expect(markup).not.toContain('Private retained title');
});

test('removing a local entry during an in-flight sync keeps its receipt and queues removal of that receipt result', () => {
  const created = localChange(
    emptyRecent(),
    { kind: 'use', entry: { kind: 'query', text: 'remove during sync' } },
    true,
    now,
  );
  const sending = created.pending[0]!;
  const removed = localChange(created, { kind: 'remove', id: created.entries[0]!.id }, true, now, sending.key);
  expect(removed.entries).toEqual([]);
  expect(removed.pending[0]).toEqual(sending);
  expect(removed.pending[1]?.change).toEqual({ kind: 'remove', id: `pending:${sending.key}` });
  expect(localChange(created, { kind: 'remove', id: created.entries[0]!.id }, true, now).pending).toEqual([]);
});
