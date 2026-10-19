import { describe, expect, test } from 'bun:test';
import { listHref, listViews, parseListView } from './list-state.ts';

describe('proposal list addresses', () => {
  test('both views round-trip through the same server and client address owner', () => {
    expect(listViews).toEqual(['mine', 'review-requested']);
    expect(listHref('mine')).toBe('/proposals');
    expect(listHref('review-requested')).toBe('/proposals?view=review-requested');
    for (const view of listViews) {
      const url = new URL(listHref(view), 'https://rezics.test');
      expect(parseListView(url.searchParams.get('view') ?? undefined)).toBe(view);
    }
  });

  test('missing, unknown and repeated views fall back to the viewer’s own proposals', () => {
    for (const value of [undefined, '', 'mine', 'unknown', 'REVIEW-REQUESTED', ['review-requested'], ['mine', 'review-requested']]) {
      expect(parseListView(value)).toBe('mine');
    }
  });
});
