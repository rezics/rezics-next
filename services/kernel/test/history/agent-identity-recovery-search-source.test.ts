import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../../src/command/command.ts';
import {
  observeAccountErasureSearch,
  verifyAccountErasureSearchObservation,
} from '../../src/search/account-erasure-source.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

type State = {
  owners: { partition_no: number; write_state: string }[];
  account: { state: string; authn_fenced: boolean; revision: string } | null;
  generations: { prefix: string; generation: string; index_uuid: string | null; incarnation: string; state: string }[];
  population: { complete: boolean; certified: boolean } | null;
  copy: { position: string; revision: string; deleted: boolean; settled: boolean } | null;
};

function query(state: State, statement: string) {
  if (statement.includes('FROM core.partition')) return { rows: state.owners };
  if (statement.includes('FROM access.account')) return { rows: state.account ? [state.account] : [] };
  if (statement.includes('FROM search.discovery_generation')) return { rows: state.generations };
  if (statement.includes('FROM search.discovery_population'))
    return { rows: state.population ? [state.population] : [] };
  if (statement.includes('FROM search.discovery_copy')) return { rows: state.copy ? [state.copy] : [] };
  if (statement.startsWith('BEGIN') || statement.startsWith('SET LOCAL') || statement === 'COMMIT') return { rows: [] };
  throw new Error(`Unexpected Search source query: ${statement}`);
}

function database(state: State) {
  const client = {
    async query(input: string | { text?: string }) {
      return query(state, typeof input === 'string' ? input : (input.text ?? ''));
    },
    release() {},
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    tx: { query: async (statement: string) => query(state, statement) } as unknown as CommandTransaction,
  };
}

test('Bounded History identity recovery completes supported local partitions and reports genuine remaining obligations', async () => {
  const accountId = newId(0x5130);
  const route = routeOf(accountId)!;
  const home = partitionOf(route);
  const state: State = {
    owners: [...new Set([home, 0])].map((partition_no) => ({ partition_no, write_state: 'active' })),
    account: { state: 'active', authn_fenced: false, revision: '7' },
    generations: [
      { prefix: 'rezics-', generation: '4', index_uuid: 'native-index', incarnation: 'allocation', state: 'active' },
    ],
    population: { complete: true, certified: true },
    copy: { position: '100', revision: '7', deleted: false, settled: true },
  };
  const { pool, tx } = database(state);
  const input = { accountId, accountPartition: home, eventPosition: 100n };
  const observation = await observeAccountErasureSearch(pool, input, Date.now() + 5000);
  expect(observation.state).toBe('observed');
  expect(await verifyAccountErasureSearchObservation(tx, input, observation)).toEqual({ state: 'ready' });
  expect(await verifyAccountErasureSearchObservation(tx, { ...input, eventPosition: 101n }, observation)).toEqual({
    state: 'pending',
    gap: 'agent-identity-recovery-search-currentness-changed',
  });

  state.copy = { ...state.copy!, settled: false };
  expect(await verifyAccountErasureSearchObservation(tx, input, observation)).toEqual({
    state: 'pending',
    gap: 'agent-identity-recovery-search-copy-pending',
  });

  state.copy = { ...state.copy!, settled: true };
  state.generations = [{ ...state.generations[0]!, incarnation: 'replacement-allocation' }];
  expect(await verifyAccountErasureSearchObservation(tx, input, observation)).toEqual({
    state: 'pending',
    gap: 'agent-identity-recovery-search-currentness-changed',
  });

  state.generations = [];
  const unregistered = await observeAccountErasureSearch(pool, input, Date.now() + 5000);
  expect(unregistered).toMatchObject({
    state: 'pending',
    gap: 'agent-identity-recovery-search-enrollment-unavailable',
  });
  expect(
    await verifyAccountErasureSearchObservation(tx, { ...input, accountId: newId(route + 1) }, unregistered),
  ).toEqual({ state: 'pending', gap: 'agent-identity-recovery-search-currentness-changed' });

  state.copy = { position: '100', revision: '7', deleted: false, settled: true };
  expect(
    await verifyAccountErasureSearchObservation(tx, { ...input, accountPartition: (home + 1) % 4096 }, observation),
  ).toEqual({ state: 'pending', gap: 'agent-identity-recovery-account-partition-unsupported' });
});
