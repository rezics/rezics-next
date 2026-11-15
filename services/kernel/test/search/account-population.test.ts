import { expect, test } from 'bun:test';
import { derivedId } from '../../src/route/route.ts';
import { validateAccountPage } from '../../src/search/account-discovery.ts';
import { discoveryIndexDefinition } from '../../src/search/discovery-documents.ts';

// Projection boundary coverage only; real Accounts population/current-disclosure proof needs its native owner port.
const id = (name: string) => derivedId('00000000-0000-8000-8000-000000000001', name, 160);

test('population frontiers cannot skip unordered keys and canonical mapping retains owner identity', () => {
  const rows = [id('first'), id('second')].sort().map((id) => ({
    id,
    accountKind: 'actor',
    handle: null,
    displayName: 'Visible',
    revision: 1n,
  }));
  const last = { route: 160, id: rows[1]!.id };
  expect(validateAccountPage({ partition: 10, position: 8n, accounts: rows, next: last }, 10, null, 2).next).toEqual(
    last,
  );
  expect(() =>
    validateAccountPage({ partition: 10, position: 8n, accounts: [...rows].reverse(), next: last }, 10, null, 2),
  ).toThrow();
  expect(() =>
    validateAccountPage(
      { partition: 10, position: 8n, accounts: rows, next: { route: 160, id: rows[0]!.id } },
      10,
      null,
      2,
    ),
  ).toThrow();
  expect(discoveryIndexDefinition()).toMatchObject({
    mappings: {
      _meta: { name_sort_format: 1, discovery_document_format: 1 },
      properties: { owner: { type: 'keyword' }, identity: { type: 'keyword' }, revision: { type: 'keyword' } },
    },
  });
});
