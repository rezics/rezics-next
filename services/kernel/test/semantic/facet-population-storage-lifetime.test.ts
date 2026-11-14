import { expect, mock, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import type { FacetPopulationRequest } from '../../src/semantic/facet-population-contract.ts';

const cost = () => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
const queried = { consumer: 'consumer', snapshot: { kind: 'pit', observation: 'observation' } };
let keyReads = 0;

mock.module('../../src/semantic/public-filter-source-binding.ts', () => ({
  createPublicFilterSourceBinding: () => ({
    join: async () => ({
      status: 'joined',
      cost: cost(),
      queried,
      definition: {
        source: { partition: 7, epoch: 3 },
        readDefinition: 'native-population',
        meaning: { digest: 'meaning' },
      },
    }),
  }),
}));
mock.module('../../src/semantic/subject-source-key-pages.ts', () => ({
  createSubjectSourceKeyPages: () => ({
    read: async () => ({
      status: 'eligible',
      cost: cost(),
      epoch: 3,
      position: 0n,
      ids: [`subject-${++keyReads}`],
      after: null,
      complete: true,
    }),
  }),
}));
mock.module('../../src/semantic/public-filter-source.ts', () => ({
  publicFilterSource: () => ({
    readPrivacyReductionHeads: async () => ({
      status: 'observed',
      cost: cost(),
      start: { observation: 'observation' },
      changed: [],
      blocking: [],
      routingComplete: true,
      unacknowledged: [],
    }),
  }),
}));
mock.module('../../src/semantic/copy-work-application.ts', () => ({
  createFacetPopulationSource: () => {
    throw new Error('The test uses the native producer directly');
  },
}));
const homeSql = 'SELECT epoch, writeState FROM core.partition WHERE partition_no = $1';
mock.module('../../src/partition/partition.ts', () => ({
  readPartition: async (client: PoolClient, partition: number) => {
    const result = await client.query<{ epoch: number; writeState: string }>(homeSql, [partition]);
    return result.rows[0] ?? null;
  },
}));

type Row = {
  frontier: string;
  predecessor: string | null;
  observation: string;
  binding: string;
  capture: string;
  state: unknown;
  subjects: { partition: number; subject: string }[];
  complete: boolean;
  expires: string;
};
type Query = { text: string; values?: readonly unknown[]; query_timeout?: number };

test('frontier append retires stalled checkout and query, then replays the durable winner', async () => {
  const { createNativeFacetPopulationSource } = await import('../../src/semantic/facet-population.ts');
  const rows = new Map<string, Row>();
  const successors = new Map<string, string>();
  const timeouts: number[] = [];
  let checkouts = 0;
  let dispatches = 0;
  let holdCheckoutAt = 0;
  let finishLateCheckout: ((client: PoolClient) => void) | undefined;
  let holdAppend = false;
  let finishAppend: ((result: { rows: Row[] }) => void) | undefined;
  let committedWinner: Row | undefined;
  const insert = (values: readonly unknown[]): Row | undefined => {
    const predecessor = values[2] as string | null;
    if (predecessor && successors.has(predecessor)) return undefined;
    const row: Row = {
      frontier: String(values[1]),
      predecessor,
      observation: String(values[3]),
      binding: String(values[4]),
      capture: String(values[5]),
      state: JSON.parse(String(values[6])),
      subjects: JSON.parse(String(values[7])),
      complete: values[8] as boolean,
      expires: String(values[9]),
    };
    rows.set(row.frontier, row);
    if (predecessor) successors.set(predecessor, row.frontier);
    return row;
  };
  const client = (released?: (error?: Error) => void): PoolClient => ({
    async query(config: Query) {
      dispatches++;
      timeouts.push(config.query_timeout ?? 0);
      const values = config.values ?? [];
      if (config.text === homeSql) return { rows: [{ epoch: 3, writeState: 'active' }] };
      if (config.text.includes('INSERT INTO semantic.facet_population_frontier')) {
        const saved = insert(values);
        if (holdAppend) {
          holdAppend = false;
          committedWinner = saved;
          return new Promise<{ rows: Row[] }>((resolve) => { finishAppend = resolve; });
        }
        return { rows: saved ? [saved] : [] };
      }
      if (config.text.includes('predecessor = $2::uuid')) {
        const frontier = successors.get(String(values[1]));
        const row = frontier && rows.get(frontier);
        const allowance = Number(values[2]);
        return {
          rows: row
            ? [{ ...row, subjects: row.subjects.length <= allowance ? row.subjects : [], replay_keys: row.subjects.length }]
            : [],
        };
      }
      if (config.text.includes('frontier = $2::uuid')) {
        const row = rows.get(String(values[1]));
        return { rows: row ? [{ ...row, subjects: [] }] : [] };
      }
      throw new Error('Unexpected facet population SQL');
    },
    release(error?: Error) {
      released?.(error);
    },
  }) as unknown as PoolClient;
  let appendReleaseAt = 0;
  let finishAppendRelease: ((error?: Error) => void) | undefined;
  const pool = {
    connect: () => {
      checkouts++;
      if (checkouts === holdCheckoutAt)
        return new Promise<PoolClient>((resolve) => { finishLateCheckout = resolve; });
      return Promise.resolve(client(checkouts === appendReleaseAt ? finishAppendRelease : undefined));
    },
  } as unknown as Pool;
  const source = createNativeFacetPopulationSource({
    pool,
    routeKey: new Uint8Array(32),
    access: {} as never,
    clock: () => new Date(),
  });
  const request = (frontier: string | null, lifetime = 250): FacetPopulationRequest => ({
    population: 'native-population',
    frontier,
    inputLimit: 8,
    capture: {
      kind: 'population',
      queried,
      start: null,
      context: { deadline: Date.now() + lifetime },
    },
  }) as unknown as FacetPopulationRequest;

  const root = await source.readFacetPopulationPage(request(null));
  if (root.status !== 'progress') throw new Error(`Expected a retained root, got ${root.status}`);
  expect(root.subjects).toEqual([{ partition: 0, subject: 'subject-1' }]);

  const beforeExpired = checkouts;
  expect((await source.readFacetPopulationPage(request(root.frontier, -1))).status).toBe('unavailable');
  expect(checkouts).toBe(beforeExpired);

  holdCheckoutAt = checkouts + 3; // predecessor load, successor replay, append checkout
  let lateReleaseDone!: (error?: Error) => void;
  const lateRelease = new Promise<Error | undefined>((resolve) => {
    lateReleaseDone = resolve;
  });
  expect((await source.readFacetPopulationPage(request(root.frontier))).status).toBe('unavailable');
  expect(finishLateCheckout).toBeDefined();
  const beforeLateDispatch = dispatches;
  finishLateCheckout!(client(lateReleaseDone));
  await lateRelease;
  expect(dispatches).toBe(beforeLateDispatch);
  expect(successors.has(root.frontier)).toBe(false);

  appendReleaseAt = checkouts + 3;
  const appendRelease = new Promise<Error | undefined>((resolve) => {
    finishAppendRelease = resolve;
  });
  holdAppend = true;
  expect((await source.readFacetPopulationPage(request(root.frontier))).status).toBe('unavailable');
  expect(await appendRelease).toBeInstanceOf(Error);
  expect(committedWinner?.predecessor).toBe(root.frontier);
  expect(finishAppend).toBeDefined();
  finishAppend!({ rows: [committedWinner!] }); // A late transport result cannot publish this page.

  const beforeReplayKeys = keyReads;
  const replay = await source.readFacetPopulationPage(request(root.frontier));
  if (replay.status !== 'progress') throw new Error(`Expected winner replay, got ${replay.status}`);
  expect(replay.frontier).toBe(committedWinner!.frontier);
  expect(replay.subjects).toEqual(committedWinner!.subjects);
  expect(keyReads).toBe(beforeReplayKeys);

  const continued = await source.readFacetPopulationPage(request(replay.frontier));
  if (continued.status !== 'progress') throw new Error(`Expected healthy continuation, got ${continued.status}`);
  expect(continued.frontier).not.toBe(replay.frontier);
  expect(continued.subjects).toEqual([{ partition: 2, subject: 'subject-3' }]);
  expect(timeouts.every((timeout) => timeout > 0)).toBe(true);
});
