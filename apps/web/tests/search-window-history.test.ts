import { expect, test } from 'bun:test';
import { admitSearchWindow, emptySearchWindows, restoreSearchWindows, SEARCH_WINDOW_LIMIT, searchWindowNextAllowed, searchWindowPosition } from '../src/search/search-window/history';
import { discoverySearchHref, searchLoaderDeps } from '../src/search/search-params';

const state = searchLoaderDeps({ q: '星の旅', kinds: ['work', 'character', 'person', 'collection'], language: ['ja', 'zh-Hant'], 'f.type': ['native-type'], 'r.year': JSON.stringify({ gte: '1990', lte: '2020' }), condition: JSON.stringify({ type: { in: ['native-type'] } }) });
const first = discoverySearchHref('zh-Hant', state);

test('admitted addresses give bounded deliberate return with exact predicates and an explicit first window', () => {
  let history = admitSearchWindow(emptySearchWindows(first), undefined);
  for (let number = 2; number <= 16; number++) history = admitSearchWindow(history, `opaque +/=${number}`, number === 2 ? null : `opaque +/=${number - 1}`);
  expect(history.windows).toHaveLength(SEARCH_WINDOW_LIMIT);
  const position = searchWindowPosition(history, 'opaque +/=16');
  expect(position.previous).toEqual({ cursor: 'opaque +/=15', number: 15 });
  expect(position.clipped).toBe(true);
  const returned = new URL(discoverySearchHref('zh-Hant', { ...state, cursor: position.previous!.cursor! }), 'https://search.test');
  expect(returned.searchParams.get('cursor')).toBe('opaque +/=15');
  returned.searchParams.delete('cursor');
  expect(returned.pathname + returned.search).toBe(first);
  expect(restoreSearchWindows(JSON.parse(JSON.stringify(history)), first)).toEqual(history);
  expect(restoreSearchWindows(history, first + '&q=another').windows).toEqual([]);
  expect(admitSearchWindow(history, undefined).windows).toEqual([{ cursor: null, number: 1 }]);
});

test('unknown cursors and repeated native addresses never fabricate a previous window or create a loop', () => {
  const empty = emptySearchWindows(first);
  expect(admitSearchWindow(empty, 'direct').windows).toEqual([]);
  const firstPage = admitSearchWindow(empty, undefined);
  const second = admitSearchWindow(firstPage, 'second', null);
  const third = admitSearchWindow(second, 'third', 'second');
  expect(searchWindowNextAllowed(third, 'third', 'second')).toBe(false);
  expect(searchWindowNextAllowed(third, 'third', 'third')).toBe(false);
  expect(searchWindowNextAllowed(third, 'second', 'third')).toBe(true);
  expect(admitSearchWindow(third, 'second')).toBe(third);
  expect(restoreSearchWindows({ ...third, windows: [...third.windows, third.windows[1]] }, first).windows).toEqual([]);
  expect(restoreSearchWindows({ ...third, windows: [{ cursor: 'x'.repeat(4865), number: 2 }] }, first).windows).toEqual([]);
});
