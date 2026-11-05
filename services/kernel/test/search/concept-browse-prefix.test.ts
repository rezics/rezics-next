import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import {
  matchNativeConceptStatementPrefix,
  nativeConceptStatementCoverage,
  type ConceptStatementReader,
} from '../../src/search/concept-browse-statements.ts';
import type { ConceptBrowseSource, ConceptBrowseState, ConceptBrowseStore } from '../../src/search/concept-browse.ts';

const root = newId(0),
  scheme = newId(0);
const selection = { property: 'schema:keywords', concept: root, scheme, includeChildren: true as const };
const binding = {
  release: 'release',
  graph: 'graph',
  scheme,
  membership: 'members',
  principal: 'reader',
  request: 'search',
};
const state: ConceptBrowseState = { version: 2, selection, binding, retained: { id: 'retained', revision: '1' } };
const request = { subject: newId(0), selection };
const observation = 'a'.repeat(64);
const graph: ConceptBrowseSource = {
  observe: async () => ({ status: 'current', binding }),
  children: async () => {
    throw new Error('No graph traversal while matching');
  },
};
function fixture(
  options: {
    positive?: boolean;
    changed?: number;
    unavailable?: number;
    certified?: boolean;
    brokenCursor?: boolean;
    concealed?: boolean;
    interrupted?: 'preparing' | 'unavailable';
    droppedTerminalCursor?: boolean;
  } = {},
) {
  const dispatches: number[] = [],
    validations: number[] = [];
  let retired = 0;
  const store = {
    contains: async () => {
      expect(validations).toEqual([]);
      return true;
    },
    read: async () => ({ status: 'complete' }),
    retire: async () => {
      retired++;
    },
  } as unknown as ConceptBrowseStore;
  const reader: ConceptStatementReader = async (_partition, _request, after, limit) => {
    const index = dispatches.length;
    dispatches.push(limit);
    if (options.interrupted && index === 2) return { status: options.interrupted };
    return {
      status: 'current',
      page: {
        statements: options.positive && index === 0 ? [{ property: selection.property, value: root }] : [],
        examined: index < 2 ? limit : 0,
        terminal: index >= 2,
        complete: false,
        ...(options.certified === false || options.concealed ? {} : { readyPrefix: observation }),
        ...(options.concealed
          ? nativeConceptStatementCoverage(true, after, index < 2 ? limit : 0, limit, 0, observation)
          : {}),
        after:
          options.droppedTerminalCursor && index >= 2
            ? null
            : index >= 2 || (options.brokenCursor && index === 1)
              ? after
              : {
                  slot: `00000000-0000-4000-8000-00000000000${index + 1}`,
                  candidate: '00000000-0000-4000-8000-000000000001',
                  observation,
                },
      },
      revalidate: async () => {
        validations.push(index);
        expect(dispatches.length).toBeGreaterThan(index);
        return options.changed === index ? 'changed' : options.unavailable === index ? 'unavailable' : 'current';
      },
    };
  };
  const match = (windows = 3, rows = 129) =>
    matchNativeConceptStatementPrefix(reader, graph, store, state, 0, request, { windows, rows });
  return { match, dispatches, validations, retired: () => retired };
}

test('complete absence spans rejected raw windows and an empty terminal seek, preserving exclusion', async () => {
  const f = fixture();
  const result = await f.match();
  expect(result).toEqual({ status: 'current', match: false, complete: true, windows: 3, examined: 128 });
  expect(f.dispatches).toEqual([64, 64, 1]);
  expect(f.validations).toEqual([0, 1, 2]);
  const filter = compileCurrentFilter({
    not: { statement: { property: selection.property, in: [root], concept: { scheme, includeChildren: true } } },
  });
  expect(filter.evaluate([result.match])).toBe(true);
});

test('exhausting either allowance or lacking native prefix certification cannot prove absence', async () => {
  for (const [f, windows, rows] of [
    [fixture(), 2, 129],
    [fixture(), 3, 128],
    [fixture({ certified: false }), 3, 129],
  ] as const) {
    expect(await f.match(windows, rows)).toMatchObject({ status: 'current', match: 'not_proven', complete: false });
    expect(f.dispatches.length).toBeLessThanOrEqual(windows);
    expect(f.dispatches.reduce((total, limit) => total + limit, 0)).toBeLessThanOrEqual(rows);
  }
});

test('a later rejected candidate mutation retires an earlier positive; unavailable evidence discards it', async () => {
  const changed = fixture({ positive: true, changed: 1 });
  expect(await changed.match()).toMatchObject({ status: 'restart', match: 'not_proven', complete: false });
  expect(changed.validations).toEqual([0, 1, 2]);
  expect(changed.retired()).toBe(1);
  const unavailable = fixture({ positive: true, unavailable: 1 });
  expect(await unavailable.match()).toMatchObject({ status: 'unavailable', match: 'not_proven', complete: false });
});

test('a nonadvancing full raw cursor restarts without treating the omitted suffix as absence', async () => {
  for (const f of [fixture({ brokenCursor: true }), fixture({ droppedTerminalCursor: true })]) {
    expect(await f.match()).toMatchObject({ status: 'restart', match: 'not_proven', complete: false });
    expect(f.retired()).toBe(1);
  }
});

test('unavailable revalidation cannot conceal a later rejected-candidate mutation', async () => {
  const f = fixture({ unavailable: 0, changed: 1 });
  expect(await f.match()).toMatchObject({ status: 'restart', match: 'not_proven', complete: false });
  expect(f.validations).toEqual([0, 1, 2]);
  expect(f.retired()).toBe(1);
});

test('interrupted traversal still revalidates every visited window before releasing the cut', async () => {
  for (const interrupted of ['preparing', 'unavailable'] as const) {
    const f = fixture({ interrupted, changed: 0 });
    expect(await f.match()).toMatchObject({ status: 'restart', match: 'not_proven', complete: false });
    expect(f.validations).toEqual([0, 1]);
    expect(f.retired()).toBe(1);
  }
});

test('concealed native evidence in any window prevents complete multi-window exclusion', async () => {
  const f = fixture({ concealed: true });
  expect(await f.match()).toMatchObject({ status: 'current', match: 'not_proven', complete: false });
  expect(f.validations).toEqual([0, 1, 2]);
});

test('oversized dispatch allowances are rejected before native or retained work', async () => {
  const f = fixture();
  await expect(f.match(33, 129)).rejects.toThrow('Invalid concept statement prefix allowance');
  await expect(f.match(3, 2049)).rejects.toThrow('Invalid concept statement prefix allowance');
  expect(f.dispatches).toEqual([]);
});
