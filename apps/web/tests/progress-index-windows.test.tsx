import { expect, test } from 'bun:test';
import {
  admitProgressIndexWindow,
  isProgressIndexCoordinate,
  progressIndexWindowCoordinates,
  progressIndexWindowQueryKey,
  progressIndexWindowRouteState,
  progressIndexWindowSnapshot,
  stageProgressIndexWindow,
  startProgressIndexWindows,
} from '../src/library/progress-index-windows';

const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;

test('three native windows commit exact movement, retry keeps accepted predecessors, and Previous/First reread coordinates', () => {
  const identity = 'viewer/subject/filters/locale';
  const firstCursor = 'native/one+==';
  const secondCursor = 'native/two+==';
  let windows = startProgressIndexWindows(identity, null);
  const firstMove = {
    id: id(1),
    kind: 'more' as const,
    from: null,
    to: firstCursor,
    sourceLocation: 'location-1',
    sourceRead: 'read-1',
    keyboard: true,
  };
  windows = stageProgressIndexWindow(windows, firstMove);
  const failedFirst = admitProgressIndexWindow(windows, {
    identity,
    move: firstMove.id,
    requested: firstCursor,
    admitted: firstCursor,
    eligible: false,
  });
  expect(failedFirst).toBe(windows);
  windows = admitProgressIndexWindow(windows, {
    identity,
    move: firstMove.id,
    requested: firstCursor,
    admitted: firstCursor,
    eligible: true,
  });
  expect(windows).toMatchObject({ current: firstCursor, predecessors: [null], lastMovement: firstMove.id });

  const secondMove = { ...firstMove, id: id(2), kind: 'more' as const, from: firstCursor, to: secondCursor };
  windows = stageProgressIndexWindow(windows, secondMove);
  windows = admitProgressIndexWindow(windows, {
    identity,
    move: secondMove.id,
    requested: secondCursor,
    admitted: secondCursor,
    eligible: true,
  });
  expect(windows).toMatchObject({ current: secondCursor, predecessors: [null, firstCursor] });

  const previous = { ...firstMove, id: id(3), kind: 'previous' as const, from: secondCursor, to: firstCursor };
  windows = stageProgressIndexWindow(windows, previous);
  expect(
    admitProgressIndexWindow(windows, {
      identity,
      move: previous.id,
      requested: firstCursor,
      admitted: firstCursor,
      eligible: false,
    }),
  ).toBe(windows);
  windows = admitProgressIndexWindow(windows, {
    identity,
    move: previous.id,
    requested: firstCursor,
    admitted: firstCursor,
    eligible: true,
  });
  expect(windows).toMatchObject({ current: firstCursor, predecessors: [null] });

  const firstPage = { ...firstMove, id: id(4), kind: 'first' as const, from: firstCursor, to: null };
  windows = stageProgressIndexWindow(windows, firstPage);
  windows = admitProgressIndexWindow(windows, {
    identity,
    move: firstPage.id,
    requested: null,
    admitted: null,
    eligible: true,
  });
  expect(windows).toMatchObject({ current: null, predecessors: [] });
  expect(progressIndexWindowSnapshot(windows)).toEqual({ current: null, predecessors: [] });
  expect(Object.keys(progressIndexWindowSnapshot(windows)!)).toEqual(['predecessors', 'current']);
});

test('stale cursor admission starts a first-page path and direct later entry has no inferred predecessor', () => {
  const identity = 'viewer/subject/filters/locale';
  const current = 'native/current';
  const stale = 'native/stale';
  const direct = startProgressIndexWindows(identity, current);
  expect(direct.predecessors).toEqual([]);

  const staged = stageProgressIndexWindow(direct, {
    id: id(5),
    kind: 'more',
    from: current,
    to: stale,
    sourceLocation: 'location',
    sourceRead: 'read',
    keyboard: false,
  });
  const restarted = admitProgressIndexWindow(staged, {
    identity,
    move: id(5),
    requested: stale,
    admitted: null,
    restarted: true,
    eligible: true,
  });
  expect(restarted).toMatchObject({ current: null, predecessors: [] });
  expect('staged' in restarted).toBe(false);
});

test('coordinate parsing enforces the native cursor boundary and eight-predecessor cap', () => {
  expect(isProgressIndexCoordinate('x'.repeat(4096))).toBe(true);
  expect(isProgressIndexCoordinate('x'.repeat(4097))).toBe(false);
  expect(isProgressIndexCoordinate('bad\ncoordinate')).toBe(false);
  expect(
    progressIndexWindowCoordinates({ current: null, predecessors: [null, 'opaque'], rows: [{ id: id(9) }] }),
  ).toEqual({ current: null, predecessors: [null, 'opaque'] });
  expect(progressIndexWindowCoordinates({ current: null, predecessors: Array(9).fill(null) })).toBeUndefined();
  expect(progressIndexWindowCoordinates({ current: 'x'.repeat(4097), predecessors: [] })).toBeUndefined();
  expect(
    progressIndexWindowRouteState({ progressIndexWindow: { visit: 'bad', move: id(1), from: null, to: null } }),
  ).toBeUndefined();
  expect(progressIndexWindowQueryKey(id(1))).toEqual(['library', 'progress', 'index-windows', id(1)]);
});

test('admitted forward movement retains only the eight nearest predecessor coordinates', () => {
  const identity = 'viewer/subject/filters/locale';
  let windows = startProgressIndexWindows(identity, null);
  for (let page = 1; page <= 10; page++) {
    const from = windows.current!;
    const to = `native/page-${page}`;
    const target = {
      id: id(100 + page),
      kind: 'more' as const,
      from,
      to,
      sourceLocation: `location-${page}`,
      sourceRead: `read-${page}`,
      keyboard: false,
    };
    windows = admitProgressIndexWindow(stageProgressIndexWindow(windows, target), {
      identity,
      move: target.id,
      requested: to,
      admitted: to,
      eligible: true,
    });
  }
  expect(windows.predecessors).toEqual(Array.from({ length: 8 }, (_, index) => `native/page-${index + 2}`));
  expect(windows.current).toBe('native/page-10');
});
