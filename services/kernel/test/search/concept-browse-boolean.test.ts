import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import type { FilterDocument } from '@rezics/filter';
import {
  matchNativeConceptFilter,
  type ConceptStatementCut,
  type ConceptStatementReader,
} from '../../src/search/concept-browse-statements.ts';

const subject = newId(0),
  root = newId(0),
  child = newId(0),
  scheme = newId(0);
const property = 'schema:keywords';
const observation = 'a'.repeat(64);
const selection = { property, concept: root, scheme, includeChildren: true as const };
const binding = {
  release: 'release',
  graph: 'graph',
  membership: 'members',
  scheme,
  principal: 'reader',
  request: 'search',
};
const condition = (includeChildren: boolean): FilterDocument => ({
  statement: { property, in: [root], concept: { scheme, includeChildren } },
});
function fixture(options: { changed?: boolean; concealed?: boolean; full?: boolean; lostCut?: boolean } = {}) {
  const reads: boolean[] = [],
    validations: number[] = [];
  let retired = 0,
    lateMembership = false;
  const cut: ConceptStatementCut = {
    state: { version: 2, selection, binding, retained: { id: 'retained', revision: '1' } },
    source: {
      observe: async () => ({ status: 'current', binding }),
      children: async () => {
        throw new Error('No graph expansion during Boolean matching');
      },
    },
    store: {
      create: async () => {
        throw new Error('Matching does not create cuts');
      },
      advance: async () => {
        throw new Error('Matching does not advance cuts');
      },
      seal: async () => {
        throw new Error('Matching does not seal cuts');
      },
      read: async () => ({ status: options.lostCut ? 'retired' : 'complete' }),
      retire: async () => {
        retired++;
      },
      contains: async () => {
        expect(validations).toEqual([]);
        if (reads.length > 1) lateMembership = true;
        return true;
      },
    },
  };
  const reader: ConceptStatementReader = async (_partition, request, _after, limit) => {
    const index = reads.length;
    reads.push(request.selection.includeChildren ?? false);
    return {
      status: 'current',
      page: {
        statements: options.concealed
          ? []
          : [{ property, value: child, qualifiers: [{ property: 'rezics:spoilerLevel', value: '0' }] }],
        examined: options.full ? limit : 1,
        terminal: !options.full,
        complete: !options.full && !options.concealed,
        ...(options.concealed ? {} : { readyPrefix: observation }),
        after: {
          slot: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          candidate: '00000000-0000-4000-8000-000000000001',
          observation,
        },
      },
      revalidate: async () => {
        validations.push(index);
        return options.changed && index === 0 && lateMembership ? 'changed' : 'current';
      },
    };
  };
  const match = (filter: FilterDocument, windows = 4, rows = 256) =>
    matchNativeConceptFilter(reader, 0, { subject, filter, spoilerThreshold: 0 }, () => cut, { windows, rows });
  return { match, reads, validations, retired: () => retired, reader, cut };
}

test('exact exclusion and descendant inclusion share current Boolean interpretation and deduplicated leaves', async () => {
  const f = fixture();
  const exact = condition(false),
    descendants = condition(true);
  expect(await f.match({ and: [{ not: exact }, { or: [descendants, descendants] }] })).toMatchObject({
    status: 'current',
    match: true,
    complete: true,
    windows: 2,
    examined: 2,
  });
  expect(f.reads).toEqual([false, true]);
  expect(f.validations).toEqual([0, 1]);
});

test('a rejected candidate mutation during later-leaf membership invalidates the entire Boolean result', async () => {
  const f = fixture({ changed: true });
  expect(await f.match({ and: [{ not: condition(false) }, condition(true)] })).toMatchObject({
    status: 'restart',
    match: 'not_proven',
    complete: false,
  });
  expect(f.retired()).toBeGreaterThan(0);
});

test('native allowance is shared across leaves and concealed evidence cannot satisfy NOT', async () => {
  const full = fixture({ full: true });
  expect(await full.match({ and: [condition(true), { not: condition(false) }] }, 1, 64)).toMatchObject({
    status: 'current',
    match: 'not_proven',
    complete: false,
    windows: 1,
    examined: 64,
  });
  expect(full.reads).toEqual([true]);
  expect(full.validations).toEqual([0]);
  const concealed = fixture({ concealed: true });
  expect(await concealed.match({ not: condition(false) })).toMatchObject({ match: 'not_proven', complete: false });
});

test('missing or lost retained cuts preserve unknown, and unsupported leaves are rejected before native I/O', async () => {
  const f = fixture();
  expect(
    await matchNativeConceptFilter(f.reader, 0, { subject, filter: condition(true) }, () => null, {
      windows: 1,
      rows: 64,
    }),
  ).toMatchObject({ status: 'preparing', match: 'not_proven', windows: 0 });
  await expect(f.match({ or: [condition(true), { type: { in: ['schema:Book'] } }] })).rejects.toThrow(
    'scheme-bound concept leaves',
  );
  expect(f.reads).toEqual([]);
  const lost = fixture({ lostCut: true });
  expect(await lost.match({ not: condition(false) })).toMatchObject({
    status: 'current',
    match: 'not_proven',
    complete: false,
  });
  expect(lost.validations).toEqual([0]);
});
