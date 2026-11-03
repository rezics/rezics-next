import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import { admitSearchPayload } from '../../src/search/query-payload.ts';

const prefix = 'keyset-';
type Plan = { size: number; sort: 'id'; generation: number; after?: readonly (string | number | null)[] };
const plan: Plan = { size: 2, sort: 'id', generation: 1 };

function hit(id: string, index = `${prefix}subjects-g1`) {
  return { _id: id, _index: index, _source: { partition: 10, security_revision: 1 }, sort: [id] };
}

function body(hits: ReturnType<typeof hit>[]) {
  return { hits: { total: { value: hits.length, relation: 'eq' as const }, hits } };
}

function refuse(payload: unknown, search = plan) {
  expect(() => admitSearchPayload(payload, search, prefix)).toThrow(SearchUnavailableError);
}

test('duplicate native root tuples cannot enter an ordinary keyset page', () => {
  const id = newId(160);
  const duplicate = hit(id);
  refuse(body([duplicate, structuredClone(duplicate)]));
});

test('inexact physical identities cannot enter an ordinary keyset page', () => {
  const id = newId(160);
  for (const index of [
    'foreign-subjects-g1',
    `${prefix}subjects-g2`,
    `${prefix}subjects-g1\n`,
    `${prefix}subjects-g01`,
    `${prefix}subjects-g1\r`,
  ])
    refuse(body([hit(id, index)]));
});

test('reordered native tuples cannot enter an ordinary keyset page', () => {
  const [first, second] = [newId(160), newId(160)].sort();
  refuse(body([hit(second!), hit(first!)]));
});

test('a frontier that does not strictly advance cannot enter an ordinary keyset page', () => {
  const id = newId(160);
  refuse(body([hit(id)]), { ...plan, size: 1, after: [id] });
});

test('wrong-partition native hits cannot enter an ordinary keyset page', () => {
  const root = hit(newId(160));
  refuse(
    body([
      {
        ...root,
        _source: { partition: 11, security_revision: 1 },
      },
    ]),
  );
});
