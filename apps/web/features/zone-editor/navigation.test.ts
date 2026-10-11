import { expect, test } from 'bun:test';
import {
  alignLinks, commitNavigation, foldMountPages, isNavigationDirty, isSegment, linksFromZone,
  NAV_COMMAND_LIMIT, NAV_LOAD_BATCH, NAV_PAGE_SIZE, navigationOps, navigationReadTarget, pageNameOf,
  pathEditBlocked, planNavigation, rebaseNavigationEdits, reduceNavigation, segmentFor, zoneMountPage,
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
  return { links, saved, pending: [], head, navigation, complete: true, after: null, notice: { kind: 'idle' } };
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
  expect(isNavigationDirty({ ...stale, complete: false })).toBe(true);
});

test('undoing reorder and unsaved additions clears pending edits even while loading', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  const initial = { ...state(saved), complete: false, after: 'cursor:2' };
  const moved = reduceNavigation(initial, { type: 'move', index: 1, direction: -1 });
  expect(isNavigationDirty(moved)).toBe(true);
  const restored = reduceNavigation(moved, { type: 'move', index: 0, direction: 1 });
  expect(restored.links).toEqual(saved);
  expect(restored.pending).toEqual([]);
  expect(isNavigationDirty(restored)).toBe(false);
  const added = link('New page', occurrence(10), 'new-page', null);
  const withAdded = reduceNavigation(restored, { type: 'add', link: added });
  const renamed = reduceNavigation(withAdded, { type: 'segment', id: added.id, segment: 'new-path' });
  expect(isNavigationDirty(renamed)).toBe(true);
  const removed = reduceNavigation(renamed, { type: 'remove', id: added.id });
  expect(removed.links).toEqual(saved);
  expect(removed.pending).toEqual([]);
  expect(isNavigationDirty(removed)).toBe(false);
});

test('stale recovery keeps operations whose mounts are beyond the fresh first load', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  let edited = reduceNavigation(state(saved), { type: 'remove', id: saved[1]!.id });
  const added = link('New page', occurrence(10), 'new-page', null);
  edited = reduceNavigation(edited, { type: 'add', link: added });
  const fresh = [saved[0]!, link('Remote page', occurrence(11), 'remote-page', 3)];
  const rebased = rebaseNavigationEdits(edited, fresh);
  const retargeted = reduceNavigation(edited, {
    type: 'retarget', ...rebased, saved: fresh, head: next, navigation, complete: false, after: 'cursor:2',
  });
  const continued = reduceNavigation(retargeted, { type: 'continued', links: [saved[1]!], complete: true, after: null });
  expect(continued.saved).toEqual([...fresh, saved[1]!]);
  expect(continued.links.map(link => link.segment)).toEqual(['charts', 'new-page', 'remote-page']);
  expect(continued.pending).toEqual(edited.pending);
  expect(isNavigationDirty(continued)).toBe(true);
});

test('interleaved moves retain earlier ordering intentions when the same entry moves again', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3)];
  let edited = reduceNavigation(state(saved), { type: 'move', index: 1, direction: -1 });
  edited = reduceNavigation(edited, { type: 'move', index: 2, direction: -1 });
  edited = reduceNavigation(edited, { type: 'move', index: 0, direction: 1 });
  expect(edited.links.map(item => item.id)).toEqual([saved[2]!.id, saved[1]!.id, saved[0]!.id]);
  const continued = reduceNavigation({ ...edited, complete: false, after: 'cursor:3' }, {
    type: 'continued', links: [link('Last page', occurrence(4), 'last-page', 4)], complete: true, after: null,
  });
  expect(continued.links.slice(0, 3)).toEqual(edited.links);
});

test('removing an unsaved ordering anchor preserves another entry\'s move', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3)];
  const added = link('New page', occurrence(4), 'new-page', null);
  let edited = reduceNavigation(state(saved), { type: 'add', link: added });
  edited = reduceNavigation(edited, { type: 'move', index: 1, direction: 1 });
  edited = reduceNavigation(edited, { type: 'move', index: 2, direction: 1 });
  expect(edited.links.map(item => item.id)).toEqual([saved[0]!.id, saved[2]!.id, added.id, saved[1]!.id]);
  const removed = reduceNavigation(edited, { type: 'remove', id: added.id });
  expect(removed.links).toEqual([saved[0]!, saved[2]!, saved[1]!]);
  expect(removed.pending).toContainEqual({ kind: 'remove', id: added.id });
  expect(removed.pending.filter(edit => edit.kind === 'move')).toEqual(edited.pending.filter(edit => edit.kind === 'move'));
  expect(isNavigationDirty(removed)).toBe(true);
});

test('removing an addition that landed before stale recovery removes the persisted mount', () => {
  const saved = [link('Charts', charts, 'charts', 1)];
  const added = link('Tides', tides, 'tides', null);
  const edited = reduceNavigation(state(saved), { type: 'add', link: added });
  const fresh = [...saved, link('Tides', tides, 'tides', 2)];
  const recovered = reduceNavigation(edited, {
    type: 'retarget', ...rebaseNavigationEdits(edited, fresh), saved: fresh, head: next,
    navigation, complete: true, after: null,
  });
  const removed = reduceNavigation(recovered, { type: 'remove', id: fresh[1]!.id });
  expect(removed.links).toEqual(saved);
  expect(navigationOps(removed.saved, removed.links)).toEqual([{ kind: 'remove', occurrence: occurrence(2) }]);
});

test('cancelling an added anchor never makes its dependent move anchor to itself', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  const anchor = link('New anchor', occurrence(3), 'new-anchor', null);
  const tail = link('New tail', occurrence(4), 'new-tail', null);
  let edited = reduceNavigation(state(saved), { type: 'add', link: anchor });
  edited = reduceNavigation(edited, { type: 'add', link: tail });
  edited = reduceNavigation(edited, { type: 'move', index: 1, direction: 1 });
  expect(edited.links).toEqual([saved[0]!, anchor, saved[1]!, tail]);
  const removed = reduceNavigation(edited, { type: 'remove', id: anchor.id });
  expect(removed.links).toEqual([...saved, tail]);
  expect(removed.pending.every(edit => edit.kind !== 'move' || edit.after !== edit.id)).toBe(true);
});

test('cancelling an added anchor retains its unloaded predecessor after stale recovery', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3)];
  const anchor = link('New anchor', occurrence(4), 'new-anchor', null);
  const tail = link('New tail', occurrence(5), 'new-tail', null);
  let edited = reduceNavigation(state(saved), { type: 'add', link: anchor });
  edited = reduceNavigation(edited, { type: 'add', link: tail });
  const fresh = saved.slice(0, 2);
  const recovered = reduceNavigation(edited, {
    type: 'retarget', ...rebaseNavigationEdits(edited, fresh), saved: fresh, head: next,
    navigation, complete: false, after: 'cursor:2',
  });
  const removed = reduceNavigation(recovered, { type: 'remove', id: anchor.id });
  expect(removed.pending).toEqual([...recovered.pending, { kind: 'remove', id: anchor.id }]);
  const continued = reduceNavigation(removed, { type: 'continued', links: [saved[2]!], complete: true, after: null });
  expect(continued.links).toEqual([...saved, tail]);
});

test('cancelling an added anchor keeps ordering around an unreferenced unloaded mount', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3), link('Last page', occurrence(4), 'last-page', 4)];
  const anchor = link('New anchor', occurrence(5), 'new-anchor', null);
  const tail = link('New tail', occurrence(6), 'new-tail', null);
  let edited = reduceNavigation(state(saved), { type: 'add', link: anchor });
  edited = reduceNavigation(edited, { type: 'move', index: 3, direction: -1 });
  edited = reduceNavigation(edited, { type: 'add', link: tail });
  const fresh = saved.slice(0, 2);
  const recovered = reduceNavigation(edited, {
    type: 'retarget', ...rebaseNavigationEdits(edited, fresh), saved: fresh, head: next,
    navigation, complete: false, after: 'cursor:2',
  });
  const removed = reduceNavigation(recovered, { type: 'remove', id: anchor.id });
  const continued = reduceNavigation(removed, { type: 'continued', links: saved.slice(2), complete: true, after: null });
  expect(continued.links).toEqual([saved[0]!, saved[1]!, saved[3]!, saved[2]!, tail]);
  expect(navigationOps(continued.saved, continued.links).filter(op => op.kind === 'insert').map(op => op.segment)).toEqual(['new-tail']);
});

test('editing a loaded mount after stale recovery keeps a removal beyond the first 2,000 mounts', async () => {
  const batchSize = NAV_LOAD_BATCH * NAV_PAGE_SIZE;
  const saved = Array.from({ length: batchSize + 1 }, (_, index) => {
    const n = index + 1;
    return link(`Page ${n}`, occurrence(n), `page-${n}`, n);
  });
  const removed = saved[batchSize]!;
  const edited = reduceNavigation(state(saved), { type: 'remove', id: removed.id });
  const failed = await commitNavigation(edited.saved, edited.links, edited.head, 'stale-removal', async () => ({
    ok: false, failure: 'stale', currentHead: next,
  }));
  expect(failed.ok).toBe(false);
  if (failed.ok || failed.failure !== 'stale') throw new Error('The initial save must encounter a stale head');
  const stale = reduceNavigation(edited, { type: 'stale', currentHead: failed.currentHead });
  const fresh = saved.slice(0, batchSize);
  const recovered = reduceNavigation(stale, {
    type: 'retarget', ...rebaseNavigationEdits(stale, fresh), saved: fresh, head: next,
    navigation, complete: false, after: `cursor:${batchSize}`,
  });
  const reordered = reduceNavigation(recovered, { type: 'move', index: 1, direction: -1 });
  expect(reordered.pending).toContainEqual({ kind: 'remove', id: removed.id });
  expect(reordered.complete).toBe(false);
  const continued = reduceNavigation(reordered, {
    type: 'continued', links: [removed], complete: true, after: null,
  });
  expect(continued.saved).toHaveLength(batchSize + 1);
  expect(continued.links).toHaveLength(batchSize);
  expect(continued.links.some(item => item.id === removed.id)).toBe(false);
  expect(continued.links.slice(0, 2).map(item => item.id)).toEqual([saved[1]!.id, saved[0]!.id]);
  expect(isNavigationDirty(continued)).toBe(true);

  const removals: string[] = [];
  const written = await commitNavigation(continued.saved, continued.links, continued.head, 'recovered-removal', async op => {
    if (op.kind === 'remove') removals.push(op.occurrence);
    return { ok: true, head: later, occurrence: null, replayed: false };
  });
  expect(written.ok).toBe(true);
  if (!written.ok) throw new Error('Saving the completed reload must succeed');
  expect(removals).toEqual([removed.occurrence!]);
  const committed = reduceNavigation(continued, { type: 'saved', ...written });
  expect(committed.saved.some(item => item.id === removed.id)).toBe(false);
  expect(committed.saved).toEqual(continued.links);
  expect(isNavigationDirty(committed)).toBe(false);
});

test('an unloaded move survives adding, changing a new path and removing another loaded mount', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3)];
  const edited = reduceNavigation(state(saved), { type: 'move', index: 2, direction: -1 });
  const fresh = saved.slice(0, 2);
  let recovered = reduceNavigation(edited, {
    type: 'retarget', ...rebaseNavigationEdits(edited, fresh), saved: fresh, head: next,
    navigation, complete: false, after: 'cursor:2',
  });
  const pendingMove = { kind: 'move' as const, id: saved[2]!.id, after: saved[0]!.id };
  const added = link('New page', occurrence(4), 'new-page', null);
  recovered = reduceNavigation(recovered, { type: 'add', link: added });
  expect(recovered.pending).toContainEqual(pendingMove);
  recovered = reduceNavigation(recovered, { type: 'segment', id: added.id, segment: 'new-path' });
  expect(recovered.pending).toContainEqual(pendingMove);
  recovered = reduceNavigation(recovered, { type: 'remove', id: saved[1]!.id });
  expect(recovered.pending).toContainEqual(pendingMove);
  const continued = reduceNavigation(recovered, {
    type: 'continued', links: [saved[2]!], complete: true, after: null,
  });
  expect(continued.links.map(item => item.segment)).toEqual(['charts', 'remote-page', 'new-path']);
  expect(isNavigationDirty(continued)).toBe(true);
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

test('continuing an incomplete inventory appends the server baseline and retains pending edits', async () => {
  const saved = Array.from({ length: NAV_COMMAND_LIMIT }, (_, index) => {
    const n = index + 1;
    return link(`Page ${n}`, occurrence(n + 10_000), `page-${n}`, n,
      'public', index === 0 ? { routeKey: 'alias', presentation } : {});
  });
  let edited: NavigationState = { ...state(saved), complete: false, after: 'cursor:2000' };
  edited = reduceNavigation(edited, { type: 'move', index: 1, direction: -1 });
  edited = reduceNavigation(edited, { type: 'remove', id: saved[2]!.id });
  const added = link('New page', occurrence(20_000), 'new-page', null);
  edited = reduceNavigation(edited, { type: 'add', link: added });
  edited = reduceNavigation(edited, { type: 'segment', id: added.id, segment: 'new-path' });
  expect(isNavigationDirty(edited)).toBe(true);
  expect(edited.complete).toBe(false);
  const pending = edited.pending;
  const more = link('Later page', occurrence(20_001), 'later-page', NAV_COMMAND_LIMIT + 1);
  const continued = reduceNavigation(edited, {
    type: 'continued', links: [saved[2]!, saved[1]!, more], complete: true, after: null,
  });
  expect(continued.saved).toEqual([...saved, more]);
  expect(continued.pending).toEqual(pending);
  expect(continued.links.slice(0, 2).map(item => item.id)).toEqual([saved[1]!.id, saved[0]!.id]);
  expect(continued.links.some(item => item.id === saved[2]!.id)).toBe(false);
  expect(continued.links.find(item => item.id === added.id)).toMatchObject({ segment: 'new-path', occurrence: null });
  expect(continued.links.find(item => item.id === saved[0]!.id)).toMatchObject({ routeKey: 'alias', presentation });
  expect(continued.links.at(-1)).toEqual(more);
  expect(continued.complete).toBe(true);
  expect(isNavigationDirty(continued)).toBe(true);
  const written = await commitNavigation(continued.saved, continued.links, continued.head, 'save-after-continue', async op => ({
    ok: true, head: next, occurrence: op.kind === 'insert' ? occurrence(30_000) : null, replayed: false,
  }));
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  const confirmed = reduceNavigation(continued, {
    type: 'saved', links: written.links, head: written.head, replayed: written.replayed,
  });
  expect(isNavigationDirty(confirmed)).toBe(false);
  expect(confirmed.pending).toEqual([]);
  expect(confirmed.links.some(item => item.id === saved[2]!.id)).toBe(false);
});

for (const count of [2_001, 4_500]) {
  test(`${count} navigation operations save completely across bounded batches`, async () => {
    const saved = Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return link(`Page ${n}`, occurrence(n + 10_000), `page-${n}`, n);
    });
    const keys: string[] = [];
    const progress: number[] = [];
    const written = await commitNavigation(saved, [], head, 'clear-batches', async (op, key, expectedHead) => {
      keys.push(key);
      expect(op).toEqual({ kind: 'remove', occurrence: occurrence(keys.length) });
      expect(expectedHead).toBe(keys.length === 1 ? head : occurrence(30_000 + keys.length - 1));
      return { ok: true, head: occurrence(30_000 + keys.length), occurrence: null, replayed: false };
    }, undefined, current => { progress.push(current.completed); });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.links).toEqual([]);
    expect(written.progress.completed).toBe(count);
    expect(written.progress.saved).toEqual([]);
    expect(written.head).toBe(occurrence(30_000 + count));
    expect(progress).toContain(NAV_COMMAND_LIMIT);
    expect(progress.at(-1)).toBe(count);
    expect(keys).toHaveLength(count);
    expect(new Set(keys).size).toBe(count);
    expect(keys[NAV_COMMAND_LIMIT - 1]).toBe(`clear-batches.${NAV_COMMAND_LIMIT - 1}`);
    expect(keys[NAV_COMMAND_LIMIT]).toBe('clear-batches.batch-1');
    if (count > NAV_COMMAND_LIMIT * 2) {
      expect(keys[NAV_COMMAND_LIMIT * 2 - 1]).toBe(`clear-batches.batch-1.${NAV_COMMAND_LIMIT - 1}`);
      expect(keys[NAV_COMMAND_LIMIT * 2]).toBe('clear-batches.batch-2');
    }
  });
}

test('a failure after the first batch resumes the unfinished batch without replaying committed operations', async () => {
  const count = 4_500;
  const saved = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return link(`Page ${n}`, occurrence(n + 10_000), `page-${n}`, n);
  });
  const acknowledged: string[] = [];
  const attempted: string[] = [];
  let failed = false;
  const write = async (op: Parameters<Parameters<typeof commitNavigation>[4]>[0], key: string, expectedHead: string) => {
    attempted.push(key);
    expect(expectedHead).toBe(acknowledged.length === 0 ? head : occurrence(30_000 + acknowledged.length));
    if (acknowledged.length === NAV_COMMAND_LIMIT && !failed) {
      failed = true;
      throw new Error('Response unavailable at the next batch');
    }
    expect(op).toEqual({ kind: 'remove', occurrence: occurrence(acknowledged.length + 1) });
    acknowledged.push(key);
    return { ok: true as const, head: occurrence(30_000 + acknowledged.length), occurrence: null, replayed: false };
  };
  const interrupted = await commitNavigation(saved, [], head, 'resume-batches', write);
  expect(interrupted.ok).toBe(false);
  if (interrupted.ok) return;
  expect(interrupted.failure).toBe('unavailable');
  expect(interrupted.progress.completed).toBe(NAV_COMMAND_LIMIT);
  expect(interrupted.progress.head).toBe(occurrence(30_000 + NAV_COMMAND_LIMIT));
  expect(interrupted.progress.saved).toEqual(saved.slice(NAV_COMMAND_LIMIT));
  expect(interrupted.progress.links).toEqual([]);
  const resumed = await commitNavigation(saved, [], head, 'resume-batches', write, interrupted.progress);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.progress.completed).toBe(count);
  expect(resumed.links).toEqual([]);
  expect(acknowledged).toHaveLength(count);
  expect(new Set(acknowledged).size).toBe(count);
  expect(attempted[NAV_COMMAND_LIMIT]).toBe('resume-batches.batch-1');
  expect(attempted[NAV_COMMAND_LIMIT + 1]).toBe('resume-batches.batch-1');
  expect(acknowledged[NAV_COMMAND_LIMIT]).toBe('resume-batches.batch-1');
});

test('new links beyond one batch retain occurrence anchors in every later insertion', async () => {
  const count = NAV_COMMAND_LIMIT + 1;
  const desired = Array.from({ length: count }, (_, index) => link(`Page ${index}`, occurrence(index + 10_000), `page-${index}`, null));
  let completed = 0;
  const written = await commitNavigation([], desired, head, 'insert-batches', async (op, key, expectedHead) => {
    expect(op.kind).toBe('insert');
    if (op.kind !== 'insert') throw new Error('Only new mounts are being saved');
    expect(op.position).toEqual(completed === 0 ? 'first' : { after: occurrence(completed) });
    expect(expectedHead).toBe(completed === 0 ? head : occurrence(20_000 + completed));
    if (completed === NAV_COMMAND_LIMIT) expect(key).toBe('insert-batches.batch-1');
    completed += 1;
    return { ok: true, head: occurrence(20_000 + completed), occurrence: occurrence(completed), replayed: false };
  });
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.progress.completed).toBe(count);
  expect(written.progress.saved).toEqual(written.links);
  expect(written.links.at(-1)!.occurrence).toBe(occurrence(count));
}, 15_000);

test('mixed move and insertion recovery retains inserted occurrence anchors and immutable checkpoints', async () => {
  const saved = [link('Charts', charts, 'charts', 1, 'public', { routeKey: 'alias', presentation }),
    link('Tides', tides, 'tides', 2)];
  const desired = [link('First', occurrence(10), 'first-page', null), saved[1]!,
    link('Middle', occurrence(11), 'middle-page', null), saved[0]!,
    link('Last', occurrence(12), 'last-page', null)];
  const attempts: { key: string; head: string; segment: string | null }[] = [];
  let failed = false;
  const write = async (op: Parameters<Parameters<typeof commitNavigation>[4]>[0], key: string, expectedHead: string) => {
    attempts.push({ key, head: expectedHead, segment: op.kind === 'insert' ? op.segment : null });
    if (op.kind === 'move') return { ok: true as const, head: next, occurrence: null, replayed: false };
    if (op.kind !== 'insert') throw new Error('Mounts must retain their identities');
    if (op.segment === 'first-page') {
      expect(op.position).toBe('first');
      return { ok: true as const, head: later, occurrence: occurrence(21), replayed: false };
    }
    if (op.segment === 'middle-page') {
      expect(op.position).toEqual({ after: occurrence(2) });
      if (!failed) {
        failed = true;
        return { ok: false as const, failure: 'unavailable' as const };
      }
      return { ok: true as const, head: occurrence(40), occurrence: occurrence(22), replayed: true };
    }
    expect(op.segment).toBe('last-page');
    expect(op.position).toEqual({ after: occurrence(1) });
    return { ok: true as const, head: occurrence(41), occurrence: occurrence(23), replayed: false };
  };
  const interrupted = await commitNavigation(saved, desired, head, 'mixed-save', write);
  expect(interrupted.ok).toBe(false);
  if (interrupted.ok) return;
  expect(interrupted.progress.completed).toBe(2);
  expect(interrupted.progress.links[0]).toMatchObject({ occurrence: occurrence(21) });
  expect(interrupted.progress.saved.map(item => item.occurrence)).toEqual([occurrence(21), occurrence(2), occurrence(1)]);
  const checkpoint = JSON.stringify(interrupted.progress);
  const partial = reduceNavigation(state(desired, saved), { type: 'progress', progress: interrupted.progress });
  expect(isNavigationDirty(partial)).toBe(true);
  expect(partial.pending.filter(edit => edit.kind === 'add')).toHaveLength(2);
  const resumed = await commitNavigation(saved, desired, head, 'mixed-save', write, interrupted.progress);
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(JSON.stringify(interrupted.progress)).toBe(checkpoint);
  expect(attempts.map(attempt => attempt.key)).toEqual(['mixed-save', 'mixed-save.1', 'mixed-save.2', 'mixed-save.2', 'mixed-save.3']);
  expect(attempts[2]!.head).toBe(later);
  expect(attempts[3]!.head).toBe(later);
  expect(attempts[4]!.head).toBe(occurrence(40));
  expect(resumed.links.map(item => item.occurrence)).toEqual([occurrence(21), occurrence(2), occurrence(22), occurrence(1), occurrence(23)]);
  expect(resumed.links[3]).toMatchObject({ routeKey: 'alias', presentation });
  expect(resumed.replayed).toBe(true);
  expect(resumed.progress.completed).toBe(4);
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
