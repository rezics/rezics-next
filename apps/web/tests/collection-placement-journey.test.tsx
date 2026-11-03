import { expect, test } from 'bun:test';
import {
  COLLECTION_MOVE_CURSOR_MAX_LENGTH,
  firstPageVisit,
  moveReadFailure,
  nextPageVisit,
  previousPageVisit,
} from '../src/library/collection-placement-journey/model';

test('Collection browsing keeps one previous cursor, explicit restart, and the installed cursor bound', () => {
  const page1 = firstPageVisit();
  const page2 = nextPageVisit(page1, 'opaque-page-2');
  const page3 = nextPageVisit(page2, 'opaque-page-3');
  expect(page3).toEqual({
    cursor: 'opaque-page-3',
    previousCursor: 'opaque-page-2',
    page: 3,
    canGoPrevious: true,
  });
  const previous = previousPageVisit(page3)!;
  expect(previous).toEqual({
    cursor: 'opaque-page-2',
    previousCursor: undefined,
    page: 2,
    canGoPrevious: false,
  });
  expect(previousPageVisit(previous)).toBeNull();
  expect(firstPageVisit()).toEqual({ cursor: undefined, previousCursor: undefined, page: 1, canGoPrevious: false });
  expect(nextPageVisit(page1, 'c'.repeat(COLLECTION_MOVE_CURSOR_MAX_LENGTH)).cursor).toHaveLength(4096);
  expect(() => nextPageVisit(page1, 'c'.repeat(COLLECTION_MOVE_CURSOR_MAX_LENGTH + 1))).toThrow(
    'Invalid Collection frontier',
  );
});

test('read failures stay distinct for access, expired cursors, changed destinations, and unavailable reads', () => {
  expect(moveReadFailure({ status: 403 })).toBe('denied');
  expect(moveReadFailure(new Error('stale_cursor'))).toBe('expired');
  expect(moveReadFailure(new Error('Move destination changed'))).toBe('changed');
  expect(moveReadFailure(new Error('network unavailable'))).toBe('unavailable');
});
