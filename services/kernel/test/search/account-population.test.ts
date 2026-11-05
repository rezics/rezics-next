import { expect, test } from 'bun:test';
import { derivedId } from '../../src/route/route.ts';
import { validateAccountPage, validateAccountSnapshot } from '../../src/search/account-discovery.ts';
import { accountDocumentActions, discoverySubjectActions } from '../../src/search/document.ts';
import type { AccountSnapshot } from '../../src/search/discovery.ts';
import { discoveryIndexDefinition, subjectIndexDefinition } from '../../src/search/indices.ts';

// Projection boundary coverage only; real Accounts population/current-disclosure proof needs its native owner port.
const id = (name: string) => derivedId('00000000-0000-8000-8000-000000000001', name, 160);

test('handled and handleless Account projections retain independent catalogue identities and only public text', () => {
  const handled = id('handled'),
    handleless = id('handleless');
  const snapshot = validateAccountSnapshot(
    {
      partition: 10,
      position: 12n,
      accounts: [
        { id: handled, accountKind: 'actor', handle: 'mira', displayName: 'Mira', revision: 7n, biography: 'private' },
        { id: handleless, accountKind: 'organization', handle: null, displayName: 'Mira', revision: 2n },
      ],
    },
    10,
    [handled, handleless],
    10n,
  );
  const accounts = accountDocumentActions(snapshot, [handled, handleless]);
  const subjects = discoverySubjectActions(
    {
      partition: 10,
      position: 12n,
      subjects: [
        {
          id: handled,
          type: 'schema:Person',
          visibility: 'visible',
          redirect: null,
          securityRevision: 1,
          labels: [{ language: 'en', value: 'Mira' }],
          aliases: [],
          descriptions: [],
          statements: [],
        },
      ],
    },
    [handled],
  );
  expect(accounts.map(({ id }) => id)).toEqual([`account:${handled}`, `account:${handleless}`]);
  expect(subjects[0]?.id).toBe(`subject:${handled}`);
  expect(accounts[1]).toMatchObject({ op: 'index', document: { names: ['Mira'], active_handle: null } });
  expect(accounts[0]).toMatchObject({
    op: 'index',
    version: 12n,
    document: {
      names: ['mira', 'Mira'],
      account_revision: '7',
      descriptions: [],
      facts: [],
      statements: [],
    },
  });
  for (const action of accounts) {
    if (action.op !== 'index') throw new Error('Expected Account projection');
    expect(Object.keys(action.document).sort()).toEqual([
      'account_revision',
      'active_handle',
      'descriptions',
      'facts',
      'family',
      'id',
      'identity',
      'kind',
      'name_sort',
      'names',
      'partition',
      'relation_facet_overflow',
      'statements',
    ]);
  }
});

test('current omission produces a positioned keyed delete and native revisions retain bigint precision', () => {
  const live = id('live'),
    omitted = id('fenced');
  const input: AccountSnapshot = {
    partition: 10,
    position: 43n,
    accounts: [{ id: live, accountKind: 'actor', handle: null, displayName: 'Live', revision: 9_007_199_254_740_993n }],
  };
  const snapshot = validateAccountSnapshot(input, 10, [live, omitted], 42n);
  const actions = accountDocumentActions(snapshot, [live, omitted, omitted]);
  expect(actions).toHaveLength(2);
  expect(actions[0]).toMatchObject({ document: { account_revision: '9007199254740993' } });
  expect(actions[1]).toEqual({ op: 'delete', id: `account:${omitted}`, version: 43n });
  expect(() => validateAccountSnapshot(input, 10, [live, omitted], 44n)).toThrow();
  expect(() =>
    validateAccountSnapshot({ ...input, accounts: [...input.accounts, ...input.accounts] }, 10, [live, omitted], 42n),
  ).toThrow();
});

test('population frontiers cannot skip unordered keys and successor mapping leaves legacy format intact', () => {
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
  const legacy = structuredClone(subjectIndexDefinition());
  expect(discoveryIndexDefinition()).toMatchObject({
    mappings: {
      _meta: { name_sort_format: 1, discovery_format: 1 },
      properties: { family: { type: 'keyword' }, identity: { type: 'keyword' }, account_revision: { type: 'keyword' } },
    },
  });
  expect(subjectIndexDefinition()).toEqual(legacy);
});
