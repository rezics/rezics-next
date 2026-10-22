import { expect, test } from 'bun:test';
import { FusekiClient, FusekiReadBudgetExceeded, fusekiReadBudget, withFusekiReadRequest,
  type FusekiReadObservation } from '../src/infrastructure/fuseki.ts';
import { withResourceListBudget } from '../src/modules/query/budget.ts';
import { RESOURCE_LIST_COST } from '../src/modules/query/resource-contract.ts';

test('actual ResourceList32 debits remain attributable through nested phases and exclude Realm directory calls', async () => {
  let transports = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    transports++;
    return Response.json({ boolean: true });
  } });
  const capability = 'abc123'.repeat(10) + 'abcd';
  const graph = new FusekiClient(server.url.href, capability, capability);
  const events: FusekiReadObservation[] = [];
  const outer = { signal: new AbortController().signal, callsLeft: 195, bytesLeft: 8 * 1024 * 1024,
    readPhase: 'original-discovery' };
  try {
    await expect(withFusekiReadRequest(new Request('http://main.test/v1/query'),
      { calls: 195, bytes: 8 * 1024 * 1024, deadlineMs: 10_000 },
      () => fusekiReadBudget.run(outer, async () => {
        await fusekiReadBudget.run({ signal: outer.signal, callsLeft: 163, bytesLeft: outer.bytesLeft,
          readPhase: 'realm-directory' }, async () => {
          await graph.query('ASK {}');
          await graph.query('ASK {}');
        });
        await withResourceListBudget(async () => {
          const resource = fusekiReadBudget.getStore()!;
          expect(resource.callsLeft).toBe(RESOURCE_LIST_COST.graphCalls);
          const work = { signal: resource.signal, callsLeft: 72, bytesLeft: resource.bytesLeft,
            attempt: 1, readPhase: 'position' };
          await fusekiReadBudget.run(work, async () => {
            for (let call = 0; call < 32; call++) {
              if (call === 16) { work.attempt = 2; work.readPhase = 'closing-fence'; }
              await graph.query('ASK {}');
            }
            expect(resource.callsLeft).toBe(0);
            await graph.query('ASK {}');
          });
        }, 'all', ['work', 'realm']);
      }), event => { events.push(event); })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    const calls = events.filter(event => event.stage === 'after-debit' && event.debit?.counter === 'callsLeft');
    const resourceCalls = calls.filter(event => event.allocations.some(owner => owner.readPhase === 'resource-list'));
    const realmCalls = calls.filter(event => event.allocations.some(owner => owner.readPhase === 'realm-directory'));
    expect(transports).toBe(34);
    expect(calls).toHaveLength(34);
    expect(resourceCalls).toHaveLength(32);
    expect(realmCalls).toHaveLength(2);
    expect(realmCalls.every(event => !event.allocations.some(owner => owner.readPhase === 'resource-list'))).toBe(true);
    const resourceOwners = resourceCalls.map(event => event.allocations.find(owner => owner.readPhase === 'resource-list')!);
    expect(new Set(resourceOwners.map(owner => owner.owner)).size).toBe(1);
    expect(resourceOwners.map(owner => owner.callsLeft)).toEqual(Array.from({ length: 32 }, (_, index) => 31 - index));
    expect(resourceCalls[0]!.allocations[0]).toMatchObject({ readPhase: 'position', attempt: 1 });
    expect(resourceCalls.at(-1)!.allocations[0]).toMatchObject({ readPhase: 'closing-fence', attempt: 2 });
    expect(outer.callsLeft).toBe(161);
    const refusal = events.find(event => event.stage === 'refused-debit')!;
    expect(refusal.allocations.find(owner => owner.readPhase === 'resource-list')!.owner).toBe(resourceOwners[0]!.owner);
    expect(refusal.allocations.find(owner => owner.readPhase === 'resource-list')!.callsLeft).toBe(0);
    expect(refusal).toMatchObject({ status: 'refused', httpStatus: null, cause: 'call-budget' });
    expect(events.filter(event => event.stage === 'complete' && event.httpStatus === 200)).toHaveLength(34);
  } finally { await server.stop(true); }
});
