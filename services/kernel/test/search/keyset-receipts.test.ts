import { expect, test } from 'bun:test';
import { admitSearchPayload } from '../../src/search/query-payload.ts';
import { newId } from '../../src/route/route.ts';

test('duplicate native root tuples cannot enter an ordinary keyset page', () => {
  const id = newId(160);
  const hit = { _id: id, _index: 'keyset-subjects-g1', _source: { partition: 10, security_revision: 1 }, sort: [id] };
  expect(() =>
    admitSearchPayload(
      { hits: { total: { value: 2, relation: 'eq' }, hits: [hit, structuredClone(hit)] } },
      { size: 2, sort: 'id', generation: 1 },
      'keyset-',
    ),
  ).toThrow();
});
