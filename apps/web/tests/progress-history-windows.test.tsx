import { expect, test } from 'bun:test';
import { admitHistory, historyPaths, historySearch } from '../src/library/progress-history-windows/coordinates';

test('history movement carries admitted sibling positions after producer recovery', () => {
  expect(
    historySearch({ changes: 'old', units: 'stale', logs: 'log', history: 'open' }, { changes: 'next', logs: 'log' }),
  ).toEqual({ changes: 'next', logs: 'log', history: 'open' });
});

test('native coordinate paths retain eight predecessors, reread Previous and abandon the forward branch', () => {
  const paths = historyPaths(undefined, 'independent');
  for (let n = 1; n <= 10; n++)
    admitHistory(paths, { section: 'changes', movement: 'more', cursor: `c${n}` }, `c${n}`, 'independent');
  expect(paths.changes.previous).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  admitHistory(paths, { section: 'changes', movement: 'previous', cursor: 'c9' }, 'c9', 'independent');
  admitHistory(paths, { section: 'changes', movement: 'more', cursor: 'new-branch' }, 'new-branch', 'independent');
  expect(paths.changes.previous.at(-1)).toBe('c9');
  expect(paths.changes.previous).not.toContain('c10');
  expect(paths.units).toEqual({ current: 'independent', previous: [] });
  admitHistory(paths, { section: 'changes', movement: 'first', cursor: undefined }, undefined, 'independent');
  expect(paths.changes).toEqual({ current: undefined, previous: [] });
});

test('cursorless predecessors are admitted coordinates and producer restart clears only its section', () => {
  const paths = historyPaths();
  admitHistory(paths, { section: 'changes', movement: 'more', cursor: 'c' }, 'c', undefined);
  admitHistory(paths, { section: 'units', movement: 'more', cursor: 'u' }, 'c', 'u');
  expect(paths.changes.previous).toEqual([undefined]);
  expect(paths.units.previous).toEqual([undefined]);
  admitHistory(paths, { section: 'changes', movement: 'more', cursor: 'stale' }, undefined, 'u');
  expect(paths.changes).toEqual({ current: undefined, previous: [] });
  expect(paths.units).toEqual({ current: 'u', previous: [undefined] });
});
