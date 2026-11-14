import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ACCOUNT_ROLE_BITS as R, COMMAND_HISTORY_KINDS } from '../../src/history/contract/index.ts';
import { collectionPublicationHistoryScopes } from '../../src/library/collection-publication-history.ts';

const route = 0;
const owner = '00000000-0000-7000-8000-000000000001';
const operator = '00000000-0000-7000-8000-000000000002';
const identity = [
  { accountRoute: route, accountId: owner, roles: R.actor | R.principal | R['acting-human'] },
  { accountRoute: route, accountId: operator, roles: R.operator },
];

test('publication copies combine the actual owner with only current verified identity roles', () => {
  const scopes = collectionPublicationHistoryScopes({ accountRoute: route, accountId: owner }, identity, 2);
  const accounts = [
    { accountRoute: route, accountId: owner, roles: R.owner | R.actor | R.principal | R['acting-human'] },
    { accountRoute: route, accountId: operator, roles: R.operator },
  ];
  expect(scopes.response).toEqual({ artifactType: 'command-receipt/v1', accounts });
  expect(scopes.events).toEqual([
    { artifactType: 'outbox-event/v1', accounts },
    { artifactType: 'outbox-event/v1', accounts },
  ]);
  const withoutIdentity = collectionPublicationHistoryScopes({ accountRoute: route, accountId: owner }, [], 1);
  expect(withoutIdentity.response.accounts).toEqual([{ accountRoute: route, accountId: owner, roles: R.owner }]);
});

test('publication command kinds are permanent and every producer fences before declaration and its first native effect', () => {
  expect(COMMAND_HISTORY_KINDS).toMatchObject({
    'library.collection.publication.begin': 4001,
    'library.collection.publish-selected': 4002,
    'library.collection.publication.activate': 4003,
  });
  const history = readFileSync(new URL('../../src/library/collection-publication-history.ts', import.meta.url), 'utf8');
  expect(history).toContain('commandHistoryIdentityAccounts(tx)');
  expect(history).toContain('await guardHistoryAccounts(tx, partition, accounts)');
  expect(history).toContain('await declareCommandHistory(');
  const producers = [
    {
      file: 'adapters/collection-publication-command.ts',
      effect: 'const collection = creation ? await creation.materialize(tx)',
      events: 1,
    },
    {
      file: 'collection-publication.ts',
      effect: 'const changed = await tx.query(',
      events: 2,
    },
    {
      file: 'collection-publication-final.ts',
      effect: 'await completeCollectionSourceOutput(tx',
      events: 2,
    },
  ];
  for (const producer of producers) {
    const source = readFileSync(new URL(`../../src/library/${producer.file}`, import.meta.url), 'utf8');
    const guard = source.indexOf('await guardCollectionPublicationHistory(');
    const declaration = source.indexOf('await declareCollectionPublicationHistory(');
    const effect = source.indexOf(producer.effect);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(declaration).toBeGreaterThan(guard);
    expect(effect).toBeGreaterThan(declaration);
    const call = (start: number) => source.slice(start, source.indexOf(');', start) + 2);
    const eventCount = new RegExp(`,\\s*${producer.events}\\s*,?\\s*\\)`);
    expect(call(guard)).toMatch(eventCount);
    expect(call(declaration)).toMatch(eventCount);
  }
});
