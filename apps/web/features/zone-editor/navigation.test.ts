import { expect, test } from 'bun:test';
import {
  alignLinks, commitNavigation, foldMountPages, isNavigationDirty, isSegment, linksFromZone,
  NAV_COMMAND_LIMIT, NAV_LOAD_BATCH, NAV_PAGE_SIZE, navigationOps, navigationReadTarget, pageNameOf,
  pathEditBlocked, planNavigation, reduceNavigation, segmentFor, zoneMountPage,
  type SiteLink, type NavigationState,
} from './navigation.ts';

const head = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a1';
const next = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a2';
const later = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a3';
const navigation = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000d1';
const charts = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000b1';
const tides = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000b2';
const presentation = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000e1';
const occurrence = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function link(
  name: string, target: string, segment: string, n: number | null,
  disclosure: 'public' | 'private' = 'public',
  extra: Partial<SiteLink> = {},
): SiteLink {
  return {
    id: n === null ? `new-${segment}` : occurrence(n).slice(-36),
    occurrence: n === null ? null : occurrence(n),
    target, name, segment, disclosure, ...extra,
  };
}

function state(links: SiteLink[], saved = links): NavigationState {
  return { links, saved, head, navigation, complete: true, after: null, notice: { kind: 'idle' } };
}

function mount(n: number, segment: string, target: string, extra: Record<string, unknown> = {}) {
  return {
    occurrence: occurrence(n), state: 'active', role: 'mount', target, labels: [],
    qualifier: { type: 'zone-mount', routeSegment: segment, disclosure: 'public', ...extra },
  };
}

test('a path comes from the page name and skips paths already taken or reserved', () => {
  expect(segmentFor('Harbor charts', [])).toBe('harbor-charts');
  expect(segmentFor('About', ['page'])).toBe('page-2');
  expect(segmentFor('Harbor charts', ['harbor-charts'])).toBe('harbor-charts-2');
  expect(isSegment('browse')).toBe(false);
  expect(isSegment('harbor-charts')).toBe(true);
});

test('reordering saved mounts is a move that keeps occurrence identity', () => {
  const saved = [link('Charts', charts, 'charts', 1, 'public', { routeKey: 'alias', presentation }),
    link('Tides', tides, 'tides', 2)];
  const desired = [saved[1]!, saved[0]!];
  expect(planNavigation(saved, desired)).toEqual({
    ok: true,
    ops: [{ kind: 'move', occurrence: occurrence(2), position: 'first' }],
  });
  expect(navigationOps(saved, desired)).toEqual([
    { kind: 'move', occurrence: occurrence(2), position: 'first' },
  ]);
});

test('new links still insert; a path edit on a saved mount is refused', () => {
  expect(navigationOps([], [link('Charts', charts, 'charts', null), link('Tides', tides, 'tides', null)])).toEqual([
    { kind: 'insert', target: charts, segment: 'charts', disclosure: 'public', position: 'first' },
    { kind: 'insert', target: tides, segment: 'tides', disclosure: 'public', position: 'last' },
  ]);
  const saved = [link('Charts', charts, 'charts', 1, 'public', { presentation })];
  expect(planNavigation(saved, [{ ...saved[0]!, segment: 'maps' }])).toEqual({ ok: false, reason: 'path-edit' });
  expect(pathEditBlocked(saved[0]!)).toBe(true);
  expect(pathEditBlocked(link('Charts', charts, 'charts', null))).toBe(false);
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
  expect(isNavigationDirty({ ...stale, complete: false })).toBe(false);
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
  const server = [link('Charts', charts, 'charts', 1, 'public', { presentation })];
  const aligned = alignLinks(author, server);
  expect(aligned[0]).toMatchObject({ name: 'Tides', occurrence: null });
  expect(aligned[1]).toMatchObject({ occurrence: occurrence(1), presentation });
});

test('the zone read becomes links in structure order and keeps mount metadata', () => {
  const parsed = linksFromZone({
    revision: head,
    navigation,
    ownerRevision: later,
    next: null,
    mounts: [
      { occurrence: occurrence(1), state: 'active', role: 'mount', target: charts, labels: [],
        qualifier: { type: 'zone-mount', routeSegment: 'charts', disclosure: 'public', key: 'alias', presentation } },
      { occurrence: occurrence(2), state: 'removed', role: 'mount', target: tides, labels: [],
        qualifier: { type: 'zone-mount', routeSegment: 'tides', disclosure: 'public' } },
      { occurrence: occurrence(3), state: 'active', role: 'group', target: tides, labels: ['Skip'] },
    ],
  });
  expect(parsed).toEqual({
    head, navigation, next: null, zoneHead: later,
    links: [link('charts', charts, 'charts', 1, 'public', { routeKey: 'alias', presentation })],
  });
  expect(pageNameOf({ name: { original: 'en', labels: { en: 'Harbor charts' } } })).toBe('Harbor charts');
  expect(pageNameOf({ title: { value: 'Harbor tides' } })).toBe('Harbor tides');
  expect(pageNameOf({ value: 'خرائط المرفأ', language: 'ar', direction: 'rtl' as const, basis: 'requested' })).toBe('خرائط المرفأ');
});

test('continued pages past the first 50 fold into one list; a trailing next stays incomplete', () => {
  const firstLinks = Array.from({ length: NAV_PAGE_SIZE }, (_, index) => {
    const n = index + 1;
    return mount(n, `page-${n}`, `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, 'a')}`,
      index === 0 ? { key: 'alias', presentation } : {});
  });
  const boundary = mount(51, 'page-51', tides, { presentation });
  const first = zoneMountPage({
    revision: head, navigation, ownerRevision: later, mounts: firstLinks, next: 'cursor:50',
  })!;
  const second = zoneMountPage({
    revision: head, navigation, ownerRevision: later, mounts: [boundary], next: null,
  })!;
  expect(first.links).toHaveLength(NAV_PAGE_SIZE);
  expect(first.next).toBe('cursor:50');
  const complete = foldMountPages([first, second])!;
  expect(complete.complete).toBe(true);
  expect(complete.after).toBeNull();
  expect(complete.links).toHaveLength(NAV_PAGE_SIZE + 1);
  expect(complete.links[0]).toMatchObject({ routeKey: 'alias', presentation });
  expect(complete.links[NAV_PAGE_SIZE]).toMatchObject({ segment: 'page-51', presentation });
  const incomplete = foldMountPages([first])!;
  expect(incomplete.complete).toBe(false);
  expect(incomplete.after).toBe('cursor:50');
});

test('continuation pages pin to the first page revision so concurrent heads cannot mix', () => {
  expect(navigationReadTarget(null, undefined)).toEqual({ kind: 'current' });
  expect(navigationReadTarget(head, undefined)).toEqual({ kind: 'current' });
  expect(navigationReadTarget(head, 'cursor:50')).toEqual({ kind: 'revision', revision: head, after: 'cursor:50' });
  // A resume burst also pins: the first request of the burst is revision-specific.
  expect(navigationReadTarget(head, 'cursor:2000')).toEqual({
    kind: 'revision', revision: head, after: 'cursor:2000',
  });
  const first = zoneMountPage({
    revision: head, navigation, ownerRevision: later,
    mounts: [mount(1, 'one', charts)], next: 'cursor:1',
  })!;
  const mixed = zoneMountPage({
    revision: next, navigation, ownerRevision: later,
    mounts: [mount(2, 'two', tides)], next: null,
  })!;
  expect(foldMountPages([first, mixed])).toBeNull();
  const pinned = zoneMountPage({
    revision: head, navigation, ownerRevision: later,
    mounts: [mount(2, 'two', tides)], next: null,
  })!;
  expect(foldMountPages([first, pinned])).toMatchObject({ head, complete: true, after: null });
});

test('a filled load batch keeps the outstanding cursor for resume', () => {
  const pages = Array.from({ length: NAV_LOAD_BATCH }, (_, page) => zoneMountPage({
    revision: head, navigation, ownerRevision: later,
    mounts: [mount(page + 1, `page-${page + 1}`, charts)],
    next: `cursor:${(page + 1) * NAV_PAGE_SIZE}`,
  })!);
  const folded = foldMountPages(pages)!;
  expect(folded.complete).toBe(false);
  expect(folded.after).toBe(`cursor:${NAV_LOAD_BATCH * NAV_PAGE_SIZE}`);
  expect(folded.links).toHaveLength(NAV_LOAD_BATCH);
  const resumed = reduceNavigation(
    { ...state(folded.links), complete: false, after: folded.after },
    {
      type: 'continued',
      links: [link('More', tides, 'more', NAV_LOAD_BATCH + 1)],
      complete: true,
      after: null,
    },
  );
  expect(resumed.complete).toBe(true);
  expect(resumed.after).toBeNull();
  expect(resumed.links).toHaveLength(NAV_LOAD_BATCH + 1);
  expect(resumed.links.at(-1)).toMatchObject({ segment: 'more', occurrence: occurrence(NAV_LOAD_BATCH + 1) });
});

test('a save that finishes exactly at the command limit is success, not unavailable', async () => {
  const saved = Array.from({ length: NAV_COMMAND_LIMIT }, (_, index) => {
    const n = index + 1;
    return link(`Page ${n}`, `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, 'c')}`,
      `page-${n}`, n);
  });
  const keys: string[] = [];
  const written = await commitNavigation(saved, [], head, 'clear-all', async (op, key, expectedHead) => {
    keys.push(key);
    expect(op.kind).toBe('remove');
    return { ok: true, head: expectedHead === head ? next : later, occurrence: null, replayed: false };
  });
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.links).toEqual([]);
  expect(keys).toHaveLength(NAV_COMMAND_LIMIT);
  expect(keys[0]).toBe('clear-all');
  expect(keys.at(-1)).toBe(`clear-all.${NAV_COMMAND_LIMIT - 1}`);
});

test('reordering across the first-page boundary keeps untouched mount metadata', async () => {
  const saved = Array.from({ length: NAV_PAGE_SIZE + 2 }, (_, index) => {
    const n = index + 1;
    return link(`Page ${n}`, `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, 'b')}`,
      `page-${n}`, n, 'public', index === 0 || index === NAV_PAGE_SIZE
        ? { routeKey: 'alias' as const, presentation } : {});
  });
  const desired = [...saved];
  const [left, right] = [desired[NAV_PAGE_SIZE - 1]!, desired[NAV_PAGE_SIZE]!];
  desired[NAV_PAGE_SIZE - 1] = right;
  desired[NAV_PAGE_SIZE] = left;
  const plan = planNavigation(saved, desired);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.ops.every(op => op.kind === 'move')).toBe(true);
  expect(plan.ops.some(op => op.kind === 'remove' || op.kind === 'insert')).toBe(false);
  const ops: string[] = [];
  const written = await commitNavigation(saved, desired, head, 'reorder', async (op, key) => {
    ops.push(`${op.kind}:${key}`);
    return { ok: true, head: next, occurrence: null, replayed: false };
  });
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.links[0]).toMatchObject({ routeKey: 'alias', presentation, occurrence: occurrence(1) });
  expect(written.links[NAV_PAGE_SIZE]).toMatchObject({
    occurrence: left.occurrence, segment: left.segment,
  });
  expect(written.links[NAV_PAGE_SIZE - 1]).toMatchObject({
    occurrence: right.occurrence, routeKey: 'alias', presentation,
  });
  expect(ops[0]?.startsWith('move:')).toBe(true);
});
