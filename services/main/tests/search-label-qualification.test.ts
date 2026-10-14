import { expect, test } from 'bun:test';
import { indexedLabels, publicNamePage } from '../src/modules/search/labels.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

test('label page helpers consume the enclosing qualified index cut without spending another readiness budget', async () => {
  const fuseki = { commandHealth: async () => { throw new Error('Readiness already qualified by the enclosing request'); } } as unknown as FusekiClient;
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const position = { dataEpoch: 'epoch', sequence: '7', generation: 'generation', population: 2,
    serverInstanceId: 'instance', publicSearchWriteEpoch: '1' };
  let pageReads = 0;
  const session = { deps: { environment: { fuseki, lineage } }, position,
    query: async () => {
      pageReads++;
      return [{ page: { value: JSON.stringify({ hits: [], more: false, commit: '7' }) } }];
    },
  } as unknown as WorkReadSession;
  await searchGraphSnapshot.run({ clients: new Set([fuseki]), lineage, position }, async () => {
    expect((await indexedLabels(session, 'Outcome', 1, undefined, 'realm')).hits).toEqual([]);
    expect((await publicNamePage(session, 'realm', 'newest', 1)).rows).toEqual([]);
  });
  expect(pageReads).toBe(2);
});
