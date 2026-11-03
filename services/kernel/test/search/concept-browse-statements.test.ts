import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { matchNativeConceptStatements, conceptStatementRequest,
  type ConceptStatementReader } from '../../src/search/concept-browse-statements.ts';
import type { ConceptBrowseSource, ConceptBrowseState, ConceptBrowseStore } from '../../src/search/concept-browse.ts';
import type { IndexedStatement } from '../../src/search/source.ts';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';

const subject = newId(0), root = newId(0), child = newId(0), scheme = newId(0);
const selection = { property: 'schema:keywords', concept: root, scheme, includeChildren: true };
const binding = { release: 'release', graph: 'graph', membership: 'members', scheme, principal: 'reader', request: 'search' };
const state: ConceptBrowseState = { version: 2, selection: { ...selection, includeChildren: true }, binding,
  retained: { id: 'retained', revision: '1' } };
const request = { subject, selection, spoilerThreshold: 0 as const };
const graph: ConceptBrowseSource = {
  observe: async () => ({ status: 'current', binding }),
  children: async () => { throw new Error('Matching must not traverse the hierarchy'); },
};
function fixture(statements: IndexedStatement[], current: 'current' | 'changed' | 'unavailable' = 'current') {
  let retired = 0, revalidated = 0;
  const store = {
    contains: async () => true,
    read: async () => ({ status: 'complete' }),
    retire: async () => { retired++; },
  } as unknown as ConceptBrowseStore;
  const reader: ConceptStatementReader = async () => ({
    status: 'current',
    page: { statements, examined: statements.length, after: null, terminal: true, complete: false },
    revalidate: async () => { revalidated++; return current; },
  });
  return { reader, store, retired: () => retired, revalidated: () => revalidated };
}
const statement = (value: string, level: string): IndexedStatement => ({
  property: selection.property, value, qualifiers: [{ property: 'rezics:spoilerLevel', value: level }],
});

test('descendant witnesses obey their own spoilers; exact mode cannot borrow another statement', async () => {
  const f = fixture([statement(root, '2'), statement(child, '0')]);
  expect((await matchNativeConceptStatements(f.reader, graph, f.store, state, 0, request)).match).toBe(true);
  const exact = { ...request, selection: { ...selection, includeChildren: false } };
  expect((await matchNativeConceptStatements(f.reader, graph, f.store, state, 0, exact)).match).toBe('not_proven');
  expect(f.revalidated()).toBe(2);
});

test('withheld and terminal empty windows remain unknown under exclusion and Boolean alternatives', async () => {
  const f = fixture([]);
  const result = await matchNativeConceptStatements(f.reader, graph, f.store, state, 0, request);
  expect(result).toMatchObject({ status: 'current', match: 'not_proven', page: { terminal: true, complete: false } });
  const leaf = { statement: { property: selection.property, in: [root], concept: { scheme, includeChildren: true } } };
  expect(compileCurrentFilter({ not: leaf }).evaluate([result.match])).toBe('not_proven');
  expect(compileCurrentFilter({ or: [leaf, { type: { in: ['schema:Book'] } }] }).evaluate([result.match, false]))
    .toBe('not_proven');
});

test('a rejected native candidate that changes after membership forces retained-cut restart', async () => {
  const f = fixture([statement(root, '2')], 'changed');
  expect(await matchNativeConceptStatements(f.reader, graph, f.store, state, 0, request))
    .toEqual({ status: 'restart', match: 'not_proven' });
  expect(f.revalidated()).toBe(1);
  expect(f.retired()).toBe(1);
});

test('native evidence becoming unavailable discards a positive provisional match', async () => {
  const f = fixture([statement(root, '0')], 'unavailable');
  expect(await matchNativeConceptStatements(f.reader, graph, f.store, state, 0, request))
    .toEqual({ status: 'unavailable', match: 'not_proven' });
});

test('native resumption replacement retires the cut without publishing a cursor or verdict', async () => {
  const f = fixture([]);
  const reader: ConceptStatementReader = async () => ({ status: 'changed' });
  expect(await matchNativeConceptStatements(reader, graph, f.store, state, 0, request))
    .toEqual({ status: 'restart', match: 'not_proven' });
  expect(f.retired()).toBe(1);
});

test('admission owns conditions before native IO and rejects over-budget statement dispatch', async () => {
  const mutable = { subject, selection: { ...selection }, qualifiers: [{ property: 'rezics:spoilerLevel', in: ['0'] }] };
  const admitted = conceptStatementRequest(0, mutable, null, 64);
  mutable.selection.concept = child;
  mutable.qualifiers[0]!.in[0] = '2';
  expect(admitted.selection.concept).toBe(root);
  expect(admitted.qualifiers?.[0]?.in).toEqual(['0']);
  expect(() => conceptStatementRequest(0, request, null, 65)).toThrow('Invalid concept statement request');
  expect(() => conceptStatementRequest(1, request, null, 64)).toThrow('Invalid concept statement request');
});
