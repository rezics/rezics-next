import { expect, test } from 'bun:test';
import {
  commitNavigation,
  foldMountPages,
  isNavigationDirty,
  isSegment,
  linksFromZone,
  NAV_COMMAND_LIMIT,
  NAV_LOAD_BATCH,
  NAV_PAGE_SIZE,
  navigationReadTarget,
  pageNameOf,
  pathEditBlocked,
  planNavigation,
  reduceNavigation,
  segmentFor,
  zoneMountPage,
  type SiteLink,
  type NavigationState,
  type NavigationEdit,
  type NavigationSaveProgress,
} from './navigation.ts';

const head = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a1';
const next = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a2';
const later = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a3';
const navigation = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000d1';
const charts = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000b1';
const tides = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000b2';
const presentation = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000e1';
const occurrence = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function link(
  name: string,
  target: string,
  segment: string,
  n: number | null,
  disclosure: 'public' | 'private' = 'public',
  extra: Partial<SiteLink> = {},
): SiteLink {
  return {
    id: n === null ? `new-${segment}` : occurrence(n).slice(-36),
    occurrence: n === null ? null : occurrence(n),
    target,
    name,
    segment,
    disclosure,
    ...extra,
  };
}

function state(links: SiteLink[], saved = links): NavigationState {
  return {
    links,
    saved,
    pending: [],
    head,
    navigation,
    complete: true,
    after: null,
    notice: { kind: 'idle' },
  };
}

/** Fixture intent is explicit at the adapter boundary; acceptance tests use reducer operations. */
function fixtureEdits(saved: readonly SiteLink[], desired: readonly SiteLink[]): NavigationEdit[] {
  const retained = new Set(desired.flatMap((item) => (item.occurrence ? [item.occurrence] : [])));
  const edits: NavigationEdit[] = saved.flatMap((item) =>
    item.occurrence && !retained.has(item.occurrence)
      ? [{ kind: 'remove' as const, occurrence: item.occurrence, name: item.name }]
      : [],
  );
  const order = saved.flatMap((item) =>
    item.occurrence && retained.has(item.occurrence) ? [item.occurrence] : [],
  );
  let persistedIndex = 0;
  for (const [position, item] of desired.entries()) {
    if (!item.occurrence) continue;
    const at = order.indexOf(item.occurrence);
    if (at !== persistedIndex) {
      edits.push({ kind: 'move', occurrence: item.occurrence, name: item.name, position });
      order.splice(at, 1);
      order.splice(persistedIndex, 0, item.occurrence);
    }
    persistedIndex += 1;
  }
  for (const [position, item] of desired.entries()) {
    if (!item.occurrence) edits.push({ kind: 'add', link: item, position });
  }
  return edits;
}

function fixturePlan(saved: readonly SiteLink[], desired: readonly SiteLink[]) {
  return planNavigation(saved, desired, fixtureEdits(saved, desired));
}

function fixtureOps(saved: readonly SiteLink[], desired: readonly SiteLink[]) {
  const plan = fixturePlan(saved, desired);
  return plan.ok ? plan.ops : [];
}

function fixtureCommit(
  saved: readonly SiteLink[],
  desired: readonly SiteLink[],
  expectedHead: string,
  key: string,
  write: Parameters<typeof commitNavigation>[4],
  resume?: NavigationSaveProgress,
  onProgress?: (progress: NavigationSaveProgress) => void,
) {
  return commitNavigation(
    saved,
    desired,
    expectedHead,
    key,
    write,
    fixtureEdits(saved, desired),
    resume,
    onProgress,
  );
}

function mount(n: number, segment: string, target: string, extra: Record<string, unknown> = {}) {
  return {
    occurrence: occurrence(n),
    state: 'active',
    role: 'mount',
    target,
    labels: [],
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
  const saved = [
    link('Charts', charts, 'charts', 1, 'public', { routeKey: 'alias', presentation }),
    link('Tides', tides, 'tides', 2),
  ];
  const desired = [saved[1]!, saved[0]!];
  expect(fixturePlan(saved, desired)).toEqual({
    ok: true,
    ops: [{ kind: 'move', occurrence: occurrence(2), position: 'first' }],
  });
  expect(fixtureOps(saved, desired)).toEqual([
    { kind: 'move', occurrence: occurrence(2), position: 'first' },
  ]);
});

test('new links still insert; a path edit on a saved mount is refused', () => {
  expect(
    fixtureOps([], [link('Charts', charts, 'charts', null), link('Tides', tides, 'tides', null)]),
  ).toEqual([
    {
      kind: 'insert',
      clientId: 'new-charts',
      target: charts,
      segment: 'charts',
      disclosure: 'public',
      position: 'first',
    },
  ]);
  const saved = [link('Charts', charts, 'charts', 1, 'public', { presentation })];
  expect(fixturePlan(saved, [{ ...saved[0]!, segment: 'maps' }])).toEqual({
    ok: false,
    reason: 'path-edit',
  });
  expect(pathEditBlocked(saved[0]!)).toBe(true);
  expect(pathEditBlocked(link('Charts', charts, 'charts', null))).toBe(false);
});

test('saved paths reject edits while a new path and reorder save exactly the server’s paths', async () => {
  const saved = [
    link('Charts', charts, 'charts', 1, 'private', { routeKey: 'alias', presentation }),
    link('Tides', tides, 'tides', 2),
  ];
  let edited = state(saved);
  for (const item of saved) {
    const attempted = reduceNavigation(edited, {
      type: 'segment',
      id: item.id,
      segment: `changed-${item.segment}`,
    });
    expect(attempted).toEqual(edited);
    expect(attempted.links.find((candidate) => candidate.id === item.id)?.segment).toBe(
      item.segment,
    );
    edited = attempted;
  }
  expect(isNavigationDirty(edited)).toBe(false);
  const added = link('Soundings', occurrence(10), 'soundings', null);
  edited = reduceNavigation(edited, { type: 'add', link: added });
  edited = reduceNavigation(edited, {
    type: 'segment',
    id: added.id,
    segment: 'new-soundings-path',
  });
  expect(edited.links.at(-1)?.segment).toBe('new-soundings-path');
  edited = reduceNavigation(edited, { type: 'move', index: 1, direction: -1 });
  edited = reduceNavigation(edited, { type: 'move', index: 2, direction: -1 });
  let server = [...saved];
  const written = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'saved-paths',
    async (op) => {
      if (op.kind === 'remove') throw new Error('A path edit must never recreate saved mounts');
      const item =
        op.kind === 'move'
          ? server.find((candidate) => candidate.occurrence === op.occurrence)!
          : {
              ...added,
              id: occurrence(3).slice(-36),
              occurrence: occurrence(3),
              segment: op.segment,
            };
      if (op.kind === 'move')
        server = server.filter((candidate) => candidate.occurrence !== op.occurrence);
      const position = op.position;
      const at =
        position === 'first'
          ? 0
          : position === 'last'
            ? server.length
            : server.findIndex((candidate) => candidate.occurrence === position.after) + 1;
      server.splice(at, 0, item);
      return {
        ok: true,
        head: next,
        occurrence: op.kind === 'insert' ? occurrence(3) : null,
        replayed: false,
      };
    },
    edited.pending,
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(server.map((item) => item.segment)).toEqual(['tides', 'new-soundings-path', 'charts']);
  expect(written.links).toEqual(server);
  expect(written.progress.saved).toEqual(server);
  expect(server.find((item) => item.occurrence === occurrence(1))).toEqual(saved[0]);
  expect(server.find((item) => item.occurrence === occurrence(2))).toEqual(saved[1]);
  const acknowledged = reduceNavigation(edited, { type: 'saved', ...written });
  expect(acknowledged.notice).toEqual({ kind: 'saved', replayed: false });
  expect(acknowledged.links).toEqual(server);
  expect(acknowledged.saved).toEqual(server);
  expect(isNavigationDirty(acknowledged)).toBe(false);
});

test('removing one link deletes only that occurrence', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  expect(fixtureOps(saved, [saved[0]!])).toEqual([{ kind: 'remove', occurrence: occurrence(2) }]);
  expect(fixtureOps(saved, saved)).toEqual([]);
});

test('a stale save keeps the author’s order and the head they wrote against', () => {
  const start = state([link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', null)]);
  const moved = reduceNavigation(start, { type: 'move', index: 1, direction: -1 });
  const stale = reduceNavigation(moved, { type: 'stale', currentHead: null });
  expect(stale.links.map((item) => item.name)).toEqual(['Tides', 'Charts']);
  expect(stale.head).toBe(head);
  expect(stale.saved.map((item) => item.name)).toEqual(['Charts', 'Tides']);
  expect(isNavigationDirty(stale)).toBe(true);
  expect(isNavigationDirty({ ...stale, complete: false })).toBe(true);
});

test('an incomplete inventory rejects every editing operation until all pages are loaded', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  const initial = { ...state(saved), complete: false, after: 'cursor:2' };
  const added = link('New page', occurrence(10), 'new-page', null);
  for (const event of [
    { type: 'move', index: 1, direction: -1 },
    { type: 'add', link: added },
    { type: 'remove', id: saved[0]!.id },
    { type: 'segment', id: saved[0]!.id, segment: 'renamed' },
  ] as const) {
    expect(reduceNavigation(initial, event)).toEqual(initial);
  }
  const complete = reduceNavigation(initial, {
    type: 'continued',
    links: [link('Last', occurrence(3), 'last', 3)],
    complete: true,
    after: null,
  });
  expect(complete.pending).toEqual([]);
  const edited = reduceNavigation(complete, { type: 'remove', id: saved[0]!.id });
  expect(edited.pending).toEqual([{ kind: 'remove', occurrence: occurrence(1), name: 'Charts' }]);
});

test('undoing a reorder and cancelling a renamed addition leaves no placeholders', () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  let edited = reduceNavigation(state(saved), { type: 'move', index: 1, direction: -1 });
  edited = reduceNavigation(edited, { type: 'move', index: 0, direction: 1 });
  expect(edited.links).toEqual(saved);
  expect(edited.pending).toEqual([]);
  const added = link('New page', occurrence(10), 'new-page', null);
  edited = reduceNavigation(edited, { type: 'add', link: added });
  edited = reduceNavigation(edited, { type: 'segment', id: added.id, segment: 'new-path' });
  edited = reduceNavigation(edited, { type: 'remove', id: added.id });
  expect(edited.links).toEqual(saved);
  expect(edited.pending).toEqual([]);
  expect(isNavigationDirty(edited)).toBe(false);
});

test('interleaved moves keep the final visible indices of only the author’s entries', async () => {
  const saved = [
    link('Charts', charts, 'charts', 1),
    link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3),
  ];
  let edited = reduceNavigation(state(saved), { type: 'move', index: 1, direction: -1 });
  edited = reduceNavigation(edited, { type: 'move', index: 2, direction: -1 });
  edited = reduceNavigation(edited, { type: 'move', index: 0, direction: 1 });
  expect(edited.links).toEqual([saved[2]!, saved[1]!, saved[0]!]);
  const touched: string[] = [];
  const written = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'interleaved',
    async (op) => {
      expect(op.kind).toBe('move');
      if (op.kind === 'move') touched.push(op.occurrence);
      return { ok: true, head: next, occurrence: null, replayed: false };
    },
    edited.pending,
  );
  expect(written.ok).toBe(true);
  expect(touched.every((id) => id === occurrence(2) || id === occurrence(3))).toBe(true);
});

test('cancelling an addition removes it entirely and preserves another entry’s move', async () => {
  const saved = [
    link('Charts', charts, 'charts', 1),
    link('Tides', tides, 'tides', 2),
    link('Remote page', occurrence(3), 'remote-page', 3),
  ];
  const added = link('New page', occurrence(4), 'new-page', null);
  let edited = reduceNavigation(state(saved), { type: 'add', link: added });
  edited = reduceNavigation(edited, { type: 'move', index: 1, direction: 1 });
  edited = reduceNavigation(edited, { type: 'move', index: 2, direction: 1 });
  edited = reduceNavigation(edited, { type: 'remove', id: added.id });
  expect(edited.links).toEqual([saved[0]!, saved[2]!, saved[1]!]);
  expect(edited.pending).toEqual([
    { kind: 'move', occurrence: occurrence(2), name: 'Tides', position: 2 },
  ]);
  const written = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'cancel-add',
    async (op) => {
      expect(op).toEqual({
        kind: 'move',
        occurrence: occurrence(2),
        position: { after: occurrence(3) },
      });
      return { ok: true, head: next, occurrence: null, replayed: false };
    },
    edited.pending,
  );
  expect(written.ok).toBe(true);
});

test('a matching remote mount survives the cancelled-addition ordering sequence', async () => {
  const saved = [link('Charts', charts, 'charts', 1)];
  const x = link('X', occurrence(10), 'x', null);
  const y = link('Y', occurrence(11), 'y', null);
  let edited = reduceNavigation(state(saved), { type: 'add', link: x });
  edited = reduceNavigation(edited, { type: 'add', link: y });
  edited = reduceNavigation(edited, { type: 'remove', id: x.id });
  expect(edited.links).toEqual([...saved, y]);
  expect(edited.pending).toEqual([{ kind: 'add', link: y, position: 1 }]);
  const failed = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'cancel-anchor',
    async () => ({
      ok: false,
      failure: 'stale',
      currentHead: next,
    }),
    edited.pending,
  );
  expect(failed.ok).toBe(false);
  const remoteX = link('Remote X', x.target, x.segment, 20, 'private', {
    routeKey: 'alias',
    presentation,
  });
  const reviewed = reduceNavigation(edited, {
    type: 'review',
    links: [...saved, remoteX],
    head: next,
    navigation,
  });
  expect(reviewed.notice).toEqual({ kind: 'review', dropped: [] });
  expect(reviewed.links).toEqual([...saved, y, remoteX]);
  const operations: Parameters<Parameters<typeof commitNavigation>[4]>[0][] = [];
  const written = await commitNavigation(
    reviewed.saved,
    reviewed.links,
    reviewed.head,
    'reviewed-anchor',
    async (op) => {
      operations.push(op);
      return { ok: true, head: later, occurrence: occurrence(21), replayed: false };
    },
    reviewed.pending,
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(operations).toEqual([
    {
      kind: 'insert',
      clientId: y.id,
      target: y.target,
      segment: y.segment,
      disclosure: y.disclosure,
      position: { after: occurrence(1) },
    },
  ]);
  expect(written.links.at(-1)).toEqual(remoteX);
  expect(written.progress.saved.at(-1)).toEqual(remoteX);
});

test('a stale save drops and names an operation whose occurrence was removed remotely', async () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  const edited = reduceNavigation(state(saved), { type: 'remove', id: saved[1]!.id });
  const failure = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'stale-remove',
    async () => ({
      ok: false,
      failure: 'stale',
      currentHead: next,
    }),
    edited.pending,
  );
  expect(failure.ok).toBe(false);
  const replacement = link('Replacement tides', tides, 'tides', 3, 'private', { presentation });
  const current = [saved[0]!, replacement];
  const reviewed = reduceNavigation(edited, {
    type: 'review',
    links: current,
    head: next,
    navigation,
  });
  expect(reviewed.notice).toEqual({ kind: 'review', dropped: [{ kind: 'remove', name: 'Tides' }] });
  expect(reviewed.pending).toEqual([]);
  expect(reviewed.links).toEqual(current);
  expect(reviewed.saved).toEqual(current);
  let writes = 0;
  const written = await commitNavigation(
    reviewed.saved,
    reviewed.links,
    reviewed.head,
    'dropped-removal',
    async () => {
      writes += 1;
      throw new Error('No dropped operation may write');
    },
    reviewed.pending,
  );
  expect(written.ok).toBe(true);
  expect(writes).toBe(0);
});

test('review reports every missing move and remove by the author’s original name', () => {
  const saved = [
    link('Charts', charts, 'charts', 1),
    link('Tides', tides, 'tides', 2),
    link('Remote', occurrence(3), 'remote', 3),
    link('Last', occurrence(4), 'last', 4),
  ];
  let edited = reduceNavigation(state(saved), { type: 'move', index: 1, direction: -1 });
  edited = reduceNavigation(edited, { type: 'remove', id: saved[2]!.id });
  const reviewed = reduceNavigation(edited, {
    type: 'review',
    links: [saved[0]!, saved[3]!],
    head: next,
    navigation,
  });
  expect(reviewed.notice).toMatchObject({ kind: 'review' });
  if (reviewed.notice.kind !== 'review') return;
  expect(reviewed.notice.dropped).toHaveLength(2);
  expect(reviewed.notice.dropped).toContainEqual({ kind: 'move', name: 'Tides' });
  expect(reviewed.notice.dropped).toContainEqual({ kind: 'remove', name: 'Remote' });
  expect(reviewed.links).toEqual([saved[0]!, saved[3]!]);
  expect(reviewed.pending).toEqual([]);
});

test('a downward move after stale review never moves another editor’s entry', async () => {
  const saved = [link('Charts', charts, 'charts', 1), link('Tides', tides, 'tides', 2)];
  const edited = reduceNavigation(state(saved), { type: 'move', index: 0, direction: 1 });
  const remote = link('Remote', occurrence(3), 'remote', 3, 'private', {
    routeKey: 'alias',
    presentation,
  });
  const reviewed = reduceNavigation(edited, {
    type: 'review',
    links: [saved[0]!, remote, saved[1]!],
    head: next,
    navigation,
  });
  expect(reviewed.links).toEqual([remote, saved[0]!, saved[1]!]);
  const written = await commitNavigation(
    reviewed.saved,
    reviewed.links,
    reviewed.head,
    'move-down-review',
    async (op) => {
      expect(op).toEqual({
        kind: 'move',
        occurrence: occurrence(1),
        position: { after: occurrence(3) },
      });
      return { ok: true, head: later, occurrence: null, replayed: false };
    },
    reviewed.pending,
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.progress.saved).toEqual(reviewed.links);
  expect(written.links[0]).toEqual(remote);
});

test('editing mount 2,001 waits for the last page and removes only that occurrence', async () => {
  const saved = Array.from({ length: NAV_COMMAND_LIMIT + 1 }, (_, index) =>
    link(
      `Page ${index + 1}`,
      occurrence(index + 10_000),
      `page-${index + 1}`,
      index + 1,
      'public',
      index === 0 ? { routeKey: 'alias', presentation } : {},
    ),
  );
  const partial = {
    ...state(saved.slice(0, NAV_COMMAND_LIMIT)),
    complete: false,
    after: 'cursor:2000',
  };
  const completed = reduceNavigation(partial, {
    type: 'continued',
    links: [saved.at(-1)!],
    complete: true,
    after: null,
  });
  const edited = reduceNavigation(completed, { type: 'remove', id: saved.at(-1)!.id });
  expect(edited.pending).toEqual([
    { kind: 'remove', occurrence: occurrence(2_001), name: 'Page 2001' },
  ]);
  const written = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'edit-last-page',
    async (op) => {
      expect(op).toEqual({ kind: 'remove', occurrence: occurrence(2_001) });
      return { ok: true, head: next, occurrence: null, replayed: false };
    },
    edited.pending,
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.links).toEqual(saved.slice(0, NAV_COMMAND_LIMIT));
  expect(written.progress.saved).toEqual(written.links);
  const reviewed = reduceNavigation(edited, {
    type: 'review',
    links: saved,
    head: next,
    navigation,
  });
  expect(reviewed.pending).toEqual(edited.pending);
  expect(reviewed.links).toEqual(edited.links);
});

test('stale review does not move a mount whose authored move was already acknowledged', async () => {
  const saved = [
    link('Charts', charts, 'charts', 1),
    link('Tides', tides, 'tides', 2),
    link('Third', occurrence(3), 'third', 3),
    link('Last', occurrence(4), 'last', 4),
  ];
  let edited = state(saved);
  for (const index of [0, 1, 2, 0, 1, 2]) {
    edited = reduceNavigation(edited, { type: 'move', index, direction: 1 });
  }
  expect(edited.links).toEqual([saved[2]!, saved[3]!, saved[0]!, saved[1]!]);
  let attempted = 0;
  const interrupted = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'move-progress-stale',
    async (op) => {
      attempted += 1;
      if (attempted === 1) {
        expect(op).toEqual({
          kind: 'move',
          occurrence: occurrence(1),
          position: { after: occurrence(4) },
        });
        return { ok: true, head: next, occurrence: null, replayed: false };
      }
      expect(op).toEqual({
        kind: 'move',
        occurrence: occurrence(2),
        position: { after: occurrence(1) },
      });
      return { ok: false, failure: 'stale', currentHead: later };
    },
    edited.pending,
  );
  expect(interrupted.ok).toBe(false);
  if (interrupted.ok) return;
  const checkpoint = reduceNavigation(edited, { type: 'progress', progress: interrupted.progress });
  expect(checkpoint.pending).toEqual([
    { kind: 'move', occurrence: occurrence(2), name: 'Tides', position: 3 },
  ]);
  // Another author moves the acknowledged Charts mount back to the beginning.
  const reviewed = reduceNavigation(checkpoint, {
    type: 'review',
    links: saved,
    head: later,
    navigation,
  });
  expect(reviewed.notice).toEqual({ kind: 'review', dropped: [] });
  expect(reviewed.links).toEqual([saved[0]!, saved[2]!, saved[3]!, saved[1]!]);
  let writes = 0;
  const written = await commitNavigation(
    reviewed.saved,
    reviewed.links,
    reviewed.head,
    'review-move-progress',
    async (op) => {
      writes += 1;
      expect(op).toEqual({
        kind: 'move',
        occurrence: occurrence(2),
        position: { after: occurrence(4) },
      });
      return { ok: true, head: occurrence(5), occurrence: null, replayed: false };
    },
    reviewed.pending,
  );
  expect(writes).toBe(1);
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.progress.saved).toEqual(reviewed.links);
  expect(written.links[0]).toEqual(saved[0]);
});

test('stale recovery retains only unacknowledged operations after save progress', async () => {
  const saved = [
    link('Charts', charts, 'charts', 1),
    link('Tides', tides, 'tides', 2),
    link('Last', occurrence(3), 'last', 3),
  ];
  let edited = state(saved);
  for (const item of saved) edited = reduceNavigation(edited, { type: 'remove', id: item.id });
  let attempted = 0;
  const interrupted = await commitNavigation(
    edited.saved,
    edited.links,
    edited.head,
    'progress-stale',
    async () => {
      attempted += 1;
      return attempted === 1
        ? { ok: true, head: next, occurrence: null, replayed: false }
        : { ok: false, failure: 'stale', currentHead: later };
    },
    edited.pending,
  );
  expect(interrupted.ok).toBe(false);
  if (interrupted.ok) return;
  const checkpoint = reduceNavigation(edited, { type: 'progress', progress: interrupted.progress });
  expect(checkpoint.pending).toHaveLength(2);
  const remote = link('Remote', occurrence(4), 'remote', 4);
  const reviewed = reduceNavigation(checkpoint, {
    type: 'review',
    links: [saved[2]!, remote],
    head: later,
    navigation,
  });
  expect(reviewed.notice).toEqual({ kind: 'review', dropped: [{ kind: 'remove', name: 'Tides' }] });
  expect(reviewed.pending).toEqual([{ kind: 'remove', occurrence: occurrence(3), name: 'Last' }]);
  const written = await commitNavigation(
    reviewed.saved,
    reviewed.links,
    reviewed.head,
    'save-reviewed-progress',
    async (op) => {
      expect(op).toEqual({ kind: 'remove', occurrence: occurrence(3) });
      return { ok: true, head: occurrence(5), occurrence: null, replayed: false };
    },
    reviewed.pending,
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.links).toEqual([remote]);
});

test('a lost insert is retried with the same key and a stale head stops the rest', async () => {
  const desired = [link('Charts', charts, 'charts', null), link('Tides', tides, 'tides', null)];
  const keys: string[] = [];
  let attempts = 0;
  const written = await fixtureCommit(
    [],
    desired,
    head,
    'save-key',
    async (op, commandKey, expectedHead) => {
      keys.push(`${commandKey}:${expectedHead.slice(-2)}:${op.kind}`);
      attempts += 1;
      if (attempts === 1) return { ok: false, failure: 'unavailable' };
      return {
        ok: true,
        head: op.kind === 'insert' && op.segment === 'charts' ? next : later,
        occurrence: op.kind === 'insert' ? occurrence(op.segment === 'charts' ? 1 : 2) : null,
        replayed: false,
      };
    },
  );
  expect(written.ok).toBe(false);
  if (written.ok) return;
  expect(written.failure).toBe('unavailable');
  const retried = await fixtureCommit([], desired, head, 'save-key', async (op) => {
    if (op.kind === 'insert' && op.segment === 'tides')
      return { ok: false, failure: 'stale', currentHead: null };
    return { ok: true, head: next, occurrence: occurrence(1), replayed: true };
  });
  expect(retried.ok).toBe(false);
  if (retried.ok || retried.failure !== 'stale') return;
  expect(retried.links.map((item) => item.occurrence)).toEqual([occurrence(1), null]);
  expect(retried.head).toBe(next);
  expect(keys[0]).toBe(`save-key:${head.slice(-2)}:insert`);
});

test('the zone read becomes links in structure order and keeps mount metadata', () => {
  const parsed = linksFromZone({
    revision: head,
    navigation,
    ownerRevision: later,
    next: null,
    mounts: [
      {
        occurrence: occurrence(1),
        state: 'active',
        role: 'mount',
        target: charts,
        labels: [],
        qualifier: {
          type: 'zone-mount',
          routeSegment: 'charts',
          disclosure: 'public',
          key: 'alias',
          presentation,
        },
      },
      {
        occurrence: occurrence(2),
        state: 'removed',
        role: 'mount',
        target: tides,
        labels: [],
        qualifier: { type: 'zone-mount', routeSegment: 'tides', disclosure: 'public' },
      },
      {
        occurrence: occurrence(3),
        state: 'active',
        role: 'group',
        target: tides,
        labels: ['Skip'],
      },
    ],
  });
  expect(parsed).toEqual({
    head,
    navigation,
    next: null,
    zoneHead: later,
    links: [link('charts', charts, 'charts', 1, 'public', { routeKey: 'alias', presentation })],
  });
  expect(pageNameOf({ name: { original: 'en', labels: { en: 'Harbor charts' } } })).toBe(
    'Harbor charts',
  );
  expect(pageNameOf({ title: { value: 'Harbor tides' } })).toBe('Harbor tides');
  expect(
    pageNameOf({
      value: 'خرائط المرفأ',
      language: 'ar',
      direction: 'rtl' as const,
      basis: 'requested',
    }),
  ).toBe('خرائط المرفأ');
});

test('continued pages past the first 50 fold into one list; a trailing next stays incomplete', () => {
  const firstLinks = Array.from({ length: NAV_PAGE_SIZE }, (_, index) => {
    const n = index + 1;
    return mount(
      n,
      `page-${n}`,
      `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, 'a')}`,
      index === 0 ? { key: 'alias', presentation } : {},
    );
  });
  const boundary = mount(51, 'page-51', tides, { presentation });
  const first = zoneMountPage({
    revision: head,
    navigation,
    ownerRevision: later,
    mounts: firstLinks,
    next: 'cursor:50',
  })!;
  const second = zoneMountPage({
    revision: head,
    navigation,
    ownerRevision: later,
    mounts: [boundary],
    next: null,
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
  expect(navigationReadTarget(head, 'cursor:50')).toEqual({
    kind: 'revision',
    revision: head,
    after: 'cursor:50',
  });
  // A resume burst also pins: the first request of the burst is revision-specific.
  expect(navigationReadTarget(head, 'cursor:2000')).toEqual({
    kind: 'revision',
    revision: head,
    after: 'cursor:2000',
  });
  const first = zoneMountPage({
    revision: head,
    navigation,
    ownerRevision: later,
    mounts: [mount(1, 'one', charts)],
    next: 'cursor:1',
  })!;
  const mixed = zoneMountPage({
    revision: next,
    navigation,
    ownerRevision: later,
    mounts: [mount(2, 'two', tides)],
    next: null,
  })!;
  expect(foldMountPages([first, mixed])).toBeNull();
  const pinned = zoneMountPage({
    revision: head,
    navigation,
    ownerRevision: later,
    mounts: [mount(2, 'two', tides)],
    next: null,
  })!;
  expect(foldMountPages([first, pinned])).toMatchObject({ head, complete: true, after: null });
});

test('a filled load batch keeps the outstanding cursor for resume', () => {
  const pages = Array.from({ length: NAV_LOAD_BATCH }, (_, page) =>
    zoneMountPage({
      revision: head,
      navigation,
      ownerRevision: later,
      mounts: [mount(page + 1, `page-${page + 1}`, charts)],
      next: `cursor:${(page + 1) * NAV_PAGE_SIZE}`,
    })!,
  );
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
  expect(resumed.links.at(-1)).toMatchObject({
    segment: 'more',
    occurrence: occurrence(NAV_LOAD_BATCH + 1),
  });
});

test('a save that finishes exactly at the command limit is success, not unavailable', async () => {
  const saved = Array.from({ length: NAV_COMMAND_LIMIT }, (_, index) => {
    const n = index + 1;
    return link(
      `Page ${n}`,
      `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, 'c')}`,
      `page-${n}`,
      n,
    );
  });
  const keys: string[] = [];
  const written = await fixtureCommit(
    saved,
    [],
    head,
    'clear-all',
    async (op, key, expectedHead) => {
      keys.push(key);
      expect(op.kind).toBe('remove');
      return {
        ok: true,
        head: expectedHead === head ? next : later,
        occurrence: null,
        replayed: false,
      };
    },
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.links).toEqual([]);
  expect(keys).toHaveLength(NAV_COMMAND_LIMIT);
  expect(keys[0]).toBe('clear-all');
  expect(keys.at(-1)).toBe(`clear-all.${NAV_COMMAND_LIMIT - 1}`);
});

for (const count of [2_001, 4_500]) {
  test(`${count} navigation operations save completely across bounded batches`, async () => {
    const saved = Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return link(`Page ${n}`, occurrence(n + 10_000), `page-${n}`, n);
    });
    const keys: string[] = [];
    const progress: number[] = [];
    const written = await fixtureCommit(
      saved,
      [],
      head,
      'clear-batches',
      async (op, key, expectedHead) => {
        keys.push(key);
        expect(op).toEqual({ kind: 'remove', occurrence: occurrence(keys.length) });
        expect(expectedHead).toBe(keys.length === 1 ? head : occurrence(30_000 + keys.length - 1));
        return {
          ok: true,
          head: occurrence(30_000 + keys.length),
          occurrence: null,
          replayed: false,
        };
      },
      undefined,
      (current) => {
        progress.push(current.completed);
      },
    );
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
      expect(keys[NAV_COMMAND_LIMIT * 2 - 1]).toBe(
        `clear-batches.batch-1.${NAV_COMMAND_LIMIT - 1}`,
      );
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
  const write = async (
    op: Parameters<Parameters<typeof commitNavigation>[4]>[0],
    key: string,
    expectedHead: string,
  ) => {
    attempted.push(key);
    expect(expectedHead).toBe(
      acknowledged.length === 0 ? head : occurrence(30_000 + acknowledged.length),
    );
    if (acknowledged.length === NAV_COMMAND_LIMIT && !failed) {
      failed = true;
      throw new Error('Response unavailable at the next batch');
    }
    expect(op).toEqual({ kind: 'remove', occurrence: occurrence(acknowledged.length + 1) });
    acknowledged.push(key);
    return {
      ok: true as const,
      head: occurrence(30_000 + acknowledged.length),
      occurrence: null,
      replayed: false,
    };
  };
  const interrupted = await fixtureCommit(saved, [], head, 'resume-batches', write);
  expect(interrupted.ok).toBe(false);
  if (interrupted.ok) return;
  expect(interrupted.failure).toBe('unavailable');
  expect(interrupted.progress.completed).toBe(NAV_COMMAND_LIMIT);
  expect(interrupted.progress.head).toBe(occurrence(30_000 + NAV_COMMAND_LIMIT));
  expect(interrupted.progress.saved).toEqual(saved.slice(NAV_COMMAND_LIMIT));
  expect(interrupted.progress.links).toEqual([]);
  const resumed = await fixtureCommit(
    saved,
    [],
    head,
    'resume-batches',
    write,
    interrupted.progress,
  );
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
  const desired = Array.from({ length: count }, (_, index) =>
    link(`Page ${index}`, occurrence(index + 10_000), `page-${index}`, null),
  );
  let completed = 0;
  const written = await fixtureCommit(
    [],
    desired,
    head,
    'insert-batches',
    async (op, key, expectedHead) => {
      expect(op.kind).toBe('insert');
      if (op.kind !== 'insert') throw new Error('Only new mounts are being saved');
      expect(op.position).toEqual(completed === 0 ? 'first' : { after: occurrence(completed) });
      expect(expectedHead).toBe(completed === 0 ? head : occurrence(20_000 + completed));
      if (completed === NAV_COMMAND_LIMIT) expect(key).toBe('insert-batches.batch-1');
      completed += 1;
      return {
        ok: true,
        head: occurrence(20_000 + completed),
        occurrence: occurrence(completed),
        replayed: false,
      };
    },
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.progress.completed).toBe(count);
  expect(written.progress.saved).toEqual(written.links);
  expect(written.links.at(-1)!.occurrence).toBe(occurrence(count));
}, 15_000);

test('mixed move and insertion recovery retains inserted occurrence anchors and immutable checkpoints', async () => {
  const saved = [
    link('Charts', charts, 'charts', 1, 'public', { routeKey: 'alias', presentation }),
    link('Tides', tides, 'tides', 2),
  ];
  const desired = [
    link('First', occurrence(10), 'first-page', null),
    saved[1]!,
    link('Middle', occurrence(11), 'middle-page', null),
    saved[0]!,
    link('Last', occurrence(12), 'last-page', null),
  ];
  const attempts: { key: string; head: string; segment: string | null }[] = [];
  let failed = false;
  const write = async (
    op: Parameters<Parameters<typeof commitNavigation>[4]>[0],
    key: string,
    expectedHead: string,
  ) => {
    attempts.push({ key, head: expectedHead, segment: op.kind === 'insert' ? op.segment : null });
    if (op.kind === 'move')
      return { ok: true as const, head: next, occurrence: null, replayed: false };
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
      return {
        ok: true as const,
        head: occurrence(40),
        occurrence: occurrence(22),
        replayed: true,
      };
    }
    expect(op.segment).toBe('last-page');
    expect(op.position).toEqual({ after: occurrence(1) });
    return { ok: true as const, head: occurrence(41), occurrence: occurrence(23), replayed: false };
  };
  const interrupted = await fixtureCommit(saved, desired, head, 'mixed-save', write);
  expect(interrupted.ok).toBe(false);
  if (interrupted.ok) return;
  expect(interrupted.progress.completed).toBe(2);
  expect(interrupted.progress.links[0]).toMatchObject({ occurrence: occurrence(21) });
  expect(interrupted.progress.saved.map((item) => item.occurrence)).toEqual([
    occurrence(21),
    occurrence(2),
    occurrence(1),
  ]);
  const checkpoint = JSON.stringify(interrupted.progress);
  const partial = reduceNavigation(state(desired, saved), {
    type: 'progress',
    progress: interrupted.progress,
  });
  expect(isNavigationDirty(partial)).toBe(true);
  expect(partial.pending.filter((edit) => edit.kind === 'add')).toHaveLength(2);
  const resumed = await fixtureCommit(
    saved,
    desired,
    head,
    'mixed-save',
    write,
    interrupted.progress,
  );
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(JSON.stringify(interrupted.progress)).toBe(checkpoint);
  expect(attempts.map((attempt) => attempt.key)).toEqual([
    'mixed-save',
    'mixed-save.1',
    'mixed-save.2',
    'mixed-save.2',
    'mixed-save.3',
  ]);
  expect(attempts[2]!.head).toBe(later);
  expect(attempts[3]!.head).toBe(later);
  expect(attempts[4]!.head).toBe(occurrence(40));
  expect(resumed.links.map((item) => item.occurrence)).toEqual([
    occurrence(21),
    occurrence(2),
    occurrence(22),
    occurrence(1),
    occurrence(23),
  ]);
  expect(resumed.links[3]).toMatchObject({ routeKey: 'alias', presentation });
  expect(resumed.replayed).toBe(true);
  expect(resumed.progress.completed).toBe(4);
});

test('reordering across the first-page boundary keeps untouched mount metadata', async () => {
  const saved = Array.from({ length: NAV_PAGE_SIZE + 2 }, (_, index) => {
    const n = index + 1;
    return link(
      `Page ${n}`,
      `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, 'b')}`,
      `page-${n}`,
      n,
      'public',
      index === 0 || index === NAV_PAGE_SIZE ? { routeKey: 'alias' as const, presentation } : {},
    );
  });
  const [left, right] = [saved[NAV_PAGE_SIZE - 1]!, saved[NAV_PAGE_SIZE]!];
  const loaded = reduceNavigation(
    { ...state(saved.slice(0, NAV_PAGE_SIZE)), complete: false, after: 'cursor:50' },
    {
      type: 'continued',
      links: saved.slice(NAV_PAGE_SIZE),
      complete: true,
      after: null,
    },
  );
  const edited = reduceNavigation(loaded, { type: 'move', index: NAV_PAGE_SIZE, direction: -1 });
  const plan = planNavigation(edited.saved, edited.links, edited.pending);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.ops.every((op) => op.kind === 'move')).toBe(true);
  expect(plan.ops.some((op) => op.kind === 'remove' || op.kind === 'insert')).toBe(false);
  const ops: string[] = [];
  const written = await commitNavigation(
    edited.saved,
    edited.links,
    head,
    'reorder',
    async (op, key) => {
      expect(op).toEqual({
        kind: 'move',
        occurrence: right.occurrence!,
        position: { after: saved[NAV_PAGE_SIZE - 2]!.occurrence! },
      });
      ops.push(`${op.kind}:${key}`);
      return { ok: true, head: next, occurrence: null, replayed: false };
    },
    edited.pending,
  );
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  expect(written.links[0]).toMatchObject({
    routeKey: 'alias',
    presentation,
    occurrence: occurrence(1),
  });
  expect(written.links[NAV_PAGE_SIZE]).toMatchObject({
    occurrence: left.occurrence,
    segment: left.segment,
  });
  expect(written.links[NAV_PAGE_SIZE - 1]).toMatchObject({
    occurrence: right.occurrence,
    routeKey: 'alias',
    presentation,
  });
  expect(ops[0]?.startsWith('move:')).toBe(true);
});
