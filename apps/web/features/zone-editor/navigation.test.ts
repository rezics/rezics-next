import { expect, test } from 'bun:test';
import {
  alignLinks, commitNavigation, isNavigationDirty, isSegment, linksFromZone, navigationOps, pageNameOf,
  reduceNavigation, segmentFor, type SiteLink, type NavigationState,
} from './navigation.ts';

const head = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a1';
const next = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a2';
const later = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a3';
const charts = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000b1';
const tides = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000b2';
const occurrence = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-000000000c0${n}`;

function link(name: string, target: string, segment: string, n: number | null, disclosure: 'public' | 'private' = 'public'): SiteLink {
  return { id: n === null ? `new-${segment}` : occurrence(n).slice(-36), occurrence: n === null ? null : occurrence(n),
    target, name, segment, disclosure };
}

function state(links: SiteLink[], saved = links): NavigationState {
  return { links, saved, head, notice: { kind: 'idle' } };
}

test('a path comes from the page name and skips paths already taken or reserved', () => {
  expect(segmentFor('Harbor charts', [])).toBe('harbor-charts');
  expect(segmentFor('About', ['page'])).toBe('page-2');
  expect(segmentFor('Harbor charts', ['harbor-charts'])).toBe('harbor-charts-2');
  expect(isSegment('browse')).toBe(false);
  expect(isSegment('harbor-charts')).toBe(true);
});

test('adding two links and reversing them is a save of removals then inserts', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  const desired = [saved[1]!, saved[0]!];
  expect(navigationOps(saved, desired)).toEqual([
    { kind: 'remove', occurrence: occurrence(1) },
    { kind: 'remove', occurrence: occurrence(2) },
    { kind: 'insert', target: tides, segment: 'tides', disclosure: 'public' },
    { kind: 'insert', target: charts, segment: 'charts', disclosure: 'public' },
  ]);
  expect(navigationOps([], [link('Charts', charts, 'charts', null), link('Tides', tides, 'tides', null)])).toEqual([
    { kind: 'insert', target: charts, segment: 'charts', disclosure: 'public' },
    { kind: 'insert', target: tides, segment: 'tides', disclosure: 'public' },
  ]);
});

test('removing one link deletes only that occurrence', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  expect(navigationOps(saved, [saved[0]!])).toEqual([{ kind: 'remove', occurrence: occurrence(2) }]);
  expect(navigationOps(saved, saved)).toEqual([]);
});

test('a stale save keeps the author’s order and the head they wrote against', () => {
  const start = state([link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', null)]);
  const moved = reduceNavigation(start, { type: 'move', index: 1, direction: -1 });
  const stale = reduceNavigation(moved, { type: 'stale', currentHead: null });
  expect(stale.links.map(item => item.name)).toEqual(['Tides', 'Charts']);
  expect(stale.head).toBe(head);
  expect(stale.saved.map(item => item.name)).toEqual(['Charts', 'Tides']);
  expect(isNavigationDirty(stale)).toBe(true);
});

test('a lost insert is retried with the same key and a stale head stops the rest', async () => {
  const desired = [link('Charts', charts, 'charts', null), link('Tides', tides, 'tides', null)];
  const keys: string[] = [];
  let attempts = 0;
  const written = await commitNavigation([], desired, head, 'save-key', async (op, commandKey, expectedHead) => {
    keys.push(`${commandKey}:${expectedHead.slice(-2)}:${op.kind}`);
    attempts += 1;
    if (attempts === 1) return { ok: false, failure: 'unavailable' };
    return { ok: true, head: op.kind === 'insert' && op.segment === 'charts' ? next : later,
      occurrence: op.kind === 'insert' ? occurrence(op.segment === 'charts' ? 1 : 2) : null, replayed: false };
  });
  expect(written.ok).toBe(false);
  if (written.ok) return;
  expect(written.failure).toBe('unavailable');
  const retried = await commitNavigation([], desired, head, 'save-key', async op => {
    if (op.kind === 'insert' && op.segment === 'tides') return { ok: false, failure: 'stale', currentHead: null };
    return { ok: true, head: next, occurrence: occurrence(1), replayed: true };
  });
  expect(retried.ok).toBe(false);
  if (retried.ok || retried.failure !== 'stale') return;
  expect(retried.links.map(item => item.occurrence)).toEqual([occurrence(1), null]);
  expect(retried.head).toBe(next);
  expect(keys[0]).toBe(`save-key:${head.slice(-2)}:insert`);
});

test('aligning to the server keeps an unsaved link and reattaches one that landed', () => {
  const author = [link('Tides', tides, 'tides', null), link('Charts', charts, 'charts', null)];
  const server = [link('Charts', charts, 'charts', 1)];
  const aligned = alignLinks(author, server);
  expect(aligned[0]).toMatchObject({ name: 'Tides', occurrence: null });
  expect(aligned[1]?.occurrence).toBe(occurrence(1));
});

test('the zone read becomes links in structure order', () => {
  const parsed = linksFromZone({
    revision: head,
    mounts: [
      { occurrence: occurrence(1), state: 'active', role: 'mount', target: charts, labels: [],
        qualifier: { type: 'zone-mount', routeSegment: 'charts', disclosure: 'public' } },
      { occurrence: occurrence(2), state: 'removed', role: 'mount', target: tides, labels: [],
        qualifier: { type: 'zone-mount', routeSegment: 'tides', disclosure: 'public' } },
      { occurrence: occurrence(3), state: 'active', role: 'group', target: tides, labels: ['Skip'] },
    ],
  });
  expect(parsed).toEqual({ head, links: [link('charts', charts, 'charts', 1)] });
  expect(pageNameOf({ name: { original: 'en', labels: { en: 'Harbor charts' } } })).toBe('Harbor charts');
  expect(pageNameOf({ title: { value: 'Harbor tides' } })).toBe('Harbor tides');
  expect(pageNameOf({ value: 'Harbor charts', language: 'en', direction: 'ltr', basis: 'requested' })).toBe('Harbor charts');
});
