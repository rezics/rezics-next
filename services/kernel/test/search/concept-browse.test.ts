import { expect, test } from 'bun:test';
import {
  advanceConceptBrowse,
  CONCEPT_BROWSE_LIMITS,
  currentConceptMembership,
  startConceptBrowse,
  type ConceptBrowseBinding,
  type ConceptBrowseFrontier,
  type ConceptBrowseSource,
  type ConceptBrowseState,
  type ConceptBrowseStore,
} from '../../src/search/concept-browse.ts';

const binding: ConceptBrowseBinding = {
  release: 'release-a',
  graph: 'graph-a',
  scheme: 'scheme-a',
  membership: 'membership-a',
  principal: 'anonymous',
  request: 'request-a',
};
const selection = { concept: 'root', property: 'schema:keywords', scheme: 'scheme-a', includeChildren: true } as const;
const limits = { pages: 2, edges: 2, pageSize: 2 };

test('caller mutation during observation cannot enlarge the admitted worker step', async () => {
  const graph = sourceFor({ root: ['a', 'b', 'c'] });
  const { store } = retention();
  const state = (await startConceptBrowse(selection, binding, store))!;
  const allowance = { pages: 1, edges: 1, pageSize: 1 };
  const result = await advanceConceptBrowse(
    {
      ...graph.source,
      observe: async () => {
        Object.assign(allowance, CONCEPT_BROWSE_LIMITS);
        return { status: 'current', binding };
      },
    },
    store,
    state,
    allowance,
  );
  expect(result).toMatchObject({ status: 'preparing', pages: 1, edges: 1 });
  expect(graph.calls).toHaveLength(1);
});

/** Models revision-fenced retained operations; population arrays never cross the storage port. */
function retention() {
  const members = new Set<string>();
  const frontier = new Map<string, string | null>();
  let revision = 0,
    sealed = false,
    retired = false,
    reads = 0;
  const locator = () => ({ id: 'retained-plan', revision: String(revision) });
  let definition = '';
  const valid = (state: ConceptBrowseState) =>
    !retired &&
    state.retained.id === 'retained-plan' &&
    state.retained.revision === String(revision) &&
    JSON.stringify([state.selection, state.binding]) === definition;
  const store: ConceptBrowseStore = {
    async create(selected, observed) {
      definition = JSON.stringify([selected, observed]);
      members.add(selected.concept);
      frontier.set(selected.concept, null);
      revision++;
      return locator();
    },
    async read(ref) {
      reads++;
      if (!valid(ref)) return { status: 'retired' };
      if (sealed) return { status: 'complete' };
      const next = frontier.entries().next().value;
      return { status: 'building', next: next ? { parent: next[0], after: next[1] } : null };
    },
    async advance(ref, expected, delta) {
      if (!valid(ref) || sealed || !frontier.has(expected.parent) || frontier.get(expected.parent) !== expected.after)
        return null;
      if (delta.exhausted) frontier.delete(expected.parent);
      else frontier.set(expected.parent, delta.after);
      for (const child of delta.children)
        if (!members.has(child)) {
          members.add(child);
          frontier.set(child, null);
        }
      revision++;
      return locator();
    },
    async seal(ref) {
      if (!valid(ref) || frontier.size || sealed) return null;
      sealed = true;
      revision++;
      return locator();
    },
    async retire(ref) {
      if (valid(ref)) retired = true;
    },
    async contains(ref, concept) {
      return valid(ref) && sealed ? members.has(concept) : null;
    },
  };
  return {
    store,
    members,
    get reads() {
      return reads;
    },
  };
}
function sourceFor(graph: Readonly<Record<string, readonly (string | null)[]>>) {
  let observed = binding;
  const calls: ConceptBrowseFrontier[] = [];
  const source: ConceptBrowseSource = {
    observe: async () => ({ status: 'current', binding: observed }),
    children: async ({ parent, after, limit, binding: expected }) => {
      calls.push({ parent, after });
      const start = after === null ? 0 : Number(after);
      const all = graph[parent] ?? [],
        rows = all.slice(start, start + limit);
      return {
        status: 'current',
        page: {
          binding: expected,
          children: rows.filter((id): id is string => id !== null),
          examined: rows.length,
          after: rows.length ? String(start + rows.length).padStart(8, '0') : after,
          hasMore: start + rows.length < all.length,
        },
      };
    },
  };
  return {
    source,
    calls,
    observe(value: ConceptBrowseBinding) {
      observed = value;
    },
  };
}
async function finish(source: ConceptBrowseSource, store: ConceptBrowseStore, state: ConceptBrowseState) {
  for (let steps = 0; steps < 10000; steps++) {
    const result = await advanceConceptBrowse(source, store, state, limits);
    if (result.status !== 'preparing') return result;
    expect(result.pages).toBeLessThanOrEqual(limits.pages);
    expect(result.edges).toBeLessThanOrEqual(limits.edges);
    state = result.state;
  }
  throw new Error('Traversal did not finish');
}

test('retained pages finish polyhierarchy and cycles without duplicate expansion', async () => {
  const { source, calls } = sourceFor({ root: ['a', 'b'], a: ['b', 'c'], b: ['root', 'c'] });
  const { store, members } = retention();
  const state = (await startConceptBrowse(selection, binding, store))!;
  expect(await currentConceptMembership(source, store, state, 'missing')).toBe('not_proven');
  const result = await finish(source, store, state);
  expect(result.status).toBe('complete');
  expect([...members].filter((id) => id !== selection.concept).sort()).toEqual(['a', 'b', 'c']);
  expect(calls.filter(({ parent }) => parent === 'root')).toHaveLength(1);
  expect(calls.filter(({ parent }) => parent === 'c')).toHaveLength(1);
  if (result.status !== 'complete') throw new Error('Expected completion');
  expect(await currentConceptMembership(source, store, result.state, 'root')).toBe(true);
  expect(await currentConceptMembership(source, store, result.state, 'c')).toBe(true);
  expect(await currentConceptMembership(source, store, result.state, 'missing')).toBe(false);
  expect((await advanceConceptBrowse(source, store, state, limits)).status).toBe('restart');
});

test('every binding change restarts before child I/O and retires complete negative evidence', async () => {
  for (const field of Object.keys(binding) as (keyof ConceptBrowseBinding)[]) {
    const changed = sourceFor({});
    const { store } = retention();
    const state = (await startConceptBrowse(selection, binding, store))!;
    const complete = await finish(changed.source, store, state);
    if (complete.status !== 'complete') throw new Error('Expected completion');
    const childReads = changed.calls.length;
    changed.observe({ ...binding, [field]: 'changed' });
    expect(await advanceConceptBrowse(changed.source, store, complete.state, limits)).toEqual({ status: 'restart' });
    expect(changed.calls).toHaveLength(childReads);
    expect(await currentConceptMembership(changed.source, store, complete.state, 'missing')).toBe('not_proven');
    changed.observe(binding);
    expect(await currentConceptMembership(changed.source, store, complete.state, 'missing')).toBe('not_proven');
  }
});

test('full native cursors cross duplicate and empty child pages independently of child order', async () => {
  const { source, calls } = sourceFor({ root: [null, null, 'z', 'a', 'z', 'root'] });
  const { store, members } = retention();
  const state = (await startConceptBrowse(selection, binding, store))!;
  expect((await finish(source, store, state)).status).toBe('complete');
  expect([...members].sort()).toEqual(['a', 'root', 'z']);
  expect(calls.filter(({ parent }) => parent === 'root').map(({ after }) => after)).toEqual([
    null,
    '00000002',
    '00000004',
  ]);
});

test('a locator cannot be rebound, and changes during a negative lookup retire its evidence', async () => {
  const { store } = retention(),
    graph = sourceFor({});
  const result = await finish(graph.source, store, (await startConceptBrowse(selection, binding, store))!);
  if (result.status !== 'complete') throw new Error('Expected completion');
  for (const field of ['concept', 'property'] as const) {
    const changed = { ...result.state, selection: { ...selection, [field]: 'other' } };
    expect(await currentConceptMembership(graph.source, store, changed, 'missing')).toBe('not_proven');
  }
  let observations = 0;
  const changing: ConceptBrowseSource = {
    ...graph.source,
    observe: async () => ({
      status: 'current',
      binding: ++observations === 1 ? binding : { ...binding, release: 'changed' },
    }),
  };
  expect(await currentConceptMembership(changing, store, result.state, 'missing')).toBe('not_proven');
  expect(await currentConceptMembership(graph.source, store, result.state, 'missing')).toBe('not_proven');
});

test('preparation interruption resumes the retained frontier and final currentness runs on partial steps', async () => {
  const graph = sourceFor({ root: ['a', 'b', 'c'] });
  const { store } = retention();
  const state = (await startConceptBrowse(selection, binding, store))!;
  let preparing = true;
  const source: ConceptBrowseSource = {
    ...graph.source,
    children: async (input) => {
      if (preparing) {
        preparing = false;
        return { status: 'preparing' };
      }
      return graph.source.children(input);
    },
  };
  const paused = await advanceConceptBrowse(source, store, state, limits);
  expect(paused).toMatchObject({ status: 'preparing', pages: 1, edges: 0 });
  if (paused.status !== 'preparing') throw new Error('Expected preparation');
  expect((await finish(source, store, paused.state)).status).toBe('complete');

  const second = retention();
  const next = (await startConceptBrowse(selection, binding, second.store))!;
  let observations = 0;
  const changing: ConceptBrowseSource = {
    ...graph.source,
    observe: async () => ({
      status: 'current',
      binding: ++observations === 1 ? binding : { ...binding, graph: 'changed' },
    }),
  };
  expect(await advanceConceptBrowse(changing, second.store, next, limits)).toEqual({ status: 'restart' });
});

test('retirement during final observation prevents negative membership', async () => {
  const { store } = retention(),
    graph = sourceFor({});
  const result = await finish(graph.source, store, (await startConceptBrowse(selection, binding, store))!);
  if (result.status !== 'complete') throw new Error('Expected completion');
  let observations = 0;
  const expiring: ConceptBrowseSource = {
    ...graph.source,
    observe: async () => {
      if (++observations === 2) await store.retire(result.state);
      return { status: 'current', binding };
    },
  };
  expect(await currentConceptMembership(expiring, store, result.state, 'missing')).toBe('not_proven');
});

test('large retained closures do not grow step state or truncate at the filter in limit', async () => {
  const children = Array.from({ length: 130 }, (_, i) => `child-${i}`);
  const { source } = sourceFor({ root: children });
  const retained = retention();
  const state = (await startConceptBrowse(selection, binding, retained.store))!;
  const result = await finish(source, retained.store, state);
  expect(result.status).toBe('complete');
  expect(retained.members.size).toBe(131);
  if (result.status !== 'complete') throw new Error('Expected completion');
  expect(JSON.stringify(result.state).length).toBeLessThan(512);
  expect(result.state).not.toHaveProperty('discovered');
  expect(result.state).not.toHaveProperty('frontier');
  expect(await currentConceptMembership(source, retained.store, result.state, 'child-129')).toBe(true);
});

test('invalid selection and excessive step limits reject before storage or source reads', async () => {
  const { store } = retention(),
    graph = sourceFor({});
  expect(await startConceptBrowse({ ...selection, scheme: 'scheme-b' }, binding, store)).toBeNull();
  expect(await startConceptBrowse({ ...selection, includeChildren: false } as never, binding, store)).toBeNull();
  const state = (await startConceptBrowse(selection, binding, store))!;
  expect(
    await advanceConceptBrowse(graph.source, store, state, { ...limits, edges: CONCEPT_BROWSE_LIMITS.edges + 1 }),
  ).toEqual({ status: 'rejected' });
  expect(graph.calls).toHaveLength(0);
});

test('unavailable branches and nonadvancing native cursors cannot become empty closures', async () => {
  for (const invalid of [false, true]) {
    const { store } = retention();
    const state = (await startConceptBrowse(selection, binding, store))!;
    const source: ConceptBrowseSource = {
      observe: async () => ({ status: 'current', binding }),
      children: async () =>
        invalid
          ? {
              status: 'current',
              page: {
                binding,
                children: [],
                examined: 0,
                after: null,
                hasMore: true,
              },
            }
          : { status: 'unavailable' },
    };
    expect(await advanceConceptBrowse(source, store, state, limits)).toEqual({
      status: invalid ? 'restart' : 'unavailable',
    });
    expect(await currentConceptMembership(source, store, state, 'missing')).toBe('not_proven');
  }
});
