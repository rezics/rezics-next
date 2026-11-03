import { expect, test } from 'bun:test';
import {
  advanceConceptBrowse,
  startConceptBrowse,
  type ConceptBrowseBinding,
  type ConceptBrowseSource,
} from '../../src/search/concept-browse.ts';

const binding: ConceptBrowseBinding = { release: 'release-a', graph: 'graph-a', scheme: 'scheme-a' };
const selection = { concept: 'root', property: 'schema:keywords', scheme: 'scheme-a', includeChildren: true } as const;

function sourceFor(graph: Readonly<Record<string, readonly string[]>>, observed = binding) {
  const calls: { parent: string; after: string | null }[] = [];
  const source: ConceptBrowseSource = {
    observe: async () => ({ status: 'current', binding: observed }),
    children: async ({ parent, after, limit, binding: expected }) => {
      calls.push({ parent, after });
      const all = [...(graph[parent] ?? [])].sort().filter((id) => after === null || id > after);
      const children = all.slice(0, limit);
      return {
        status: 'current',
        page: { binding: expected, children, examined: children.length, hasMore: all.length > children.length },
      };
    },
  };
  return { source, calls };
}

test('descendant pages finish polyhierarchy and cycles without duplicate expansion', async () => {
  const { source, calls } = sourceFor({ root: ['a', 'b'], a: ['b', 'c'], b: ['root', 'c'] });
  let state = startConceptBrowse(selection, binding)!;
  let result = await advanceConceptBrowse(source, state, { pages: 2, edges: 2, pageSize: 2 });
  while (result.status === 'preparing') {
    state = result.state;
    result = await advanceConceptBrowse(source, state, { pages: 2, edges: 2, pageSize: 2 });
  }
  expect(result).toEqual({ status: 'complete', binding, concepts: ['a', 'b', 'c'] });
  expect(calls.filter(({ parent }) => parent === 'root')).toHaveLength(1);
  expect(calls.filter(({ parent }) => parent === 'c')).toHaveLength(1);
});

test('a changed graph restarts and an unavailable branch never becomes an empty closure', async () => {
  const changed = sourceFor({}, { ...binding, graph: 'graph-b' });
  expect(
    await advanceConceptBrowse(changed.source, startConceptBrowse(selection, binding)!, {
      pages: 1,
      edges: 1,
      pageSize: 1,
    }),
  ).toEqual({
    status: 'restart',
  });
  expect(changed.calls).toHaveLength(0);

  const unavailable: ConceptBrowseSource = {
    observe: async () => ({ status: 'current', binding }),
    children: async () => ({ status: 'unavailable' }),
  };
  expect(
    await advanceConceptBrowse(unavailable, startConceptBrowse(selection, binding)!, {
      pages: 1,
      edges: 1,
      pageSize: 1,
    }),
  ).toEqual({
    status: 'unavailable',
  });
});

test('selection cannot bind a different scheme or omit child inclusion', () => {
  expect(startConceptBrowse({ ...selection, scheme: 'scheme-b' }, binding)).toBeNull();
  expect(startConceptBrowse({ ...selection, includeChildren: false } as never, binding)).toBeNull();
});
