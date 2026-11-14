import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { publicFilterCoverageKeys } from '../../src/semantic/public-filter-coverage-pending.ts';
import { readPublicFilterPopulation } from '../../src/semantic/public-filter-coverage-population.ts';
import type {
  PrivacyReductionObservationRequest,
  PrivacyReductionStart,
} from '../../src/semantic/public-filter-source-contract.ts';
import type {
  PublicFilterAccessBindingPort,
  PublicFilterSearchBindingPort,
} from '../../src/semantic/source-binding-port.ts';

type PopulationRequest = Extract<PrivacyReductionObservationRequest, { kind: 'population' }>;
type NativeQuery = { text: string; values: unknown[]; query_timeout: number };
type NativeResult = { rows: unknown[] };

const encode = (value: unknown): string => JSON.stringify(value)!;
const search = {
  encodeState: encode,
  decodeState: <T>(value: string): T => JSON.parse(value) as T,
  encodeConsumer: encode,
  catalogue: () => undefined,
  coverageStart: () => null,
} as unknown as PublicFilterSearchBindingPort;

class AccessDeadlineError extends Error {}
const access = {
  requireDeadline(deadline: number) {
    if (Date.now() >= deadline) throw new AccessDeadlineError();
  },
  classifyUnavailability(error: unknown) {
    return error instanceof AccessDeadlineError ? 'deadline' : undefined;
  },
} as unknown as PublicFilterAccessBindingPort;

function client(
  query: (config: NativeQuery) => Promise<NativeResult>,
  release: (error?: Error) => void,
): PoolClient {
  return { query, release } as unknown as PoolClient;
}

function pool(connect: () => Promise<PoolClient>): Pool {
  return {
    connect,
    query: () => {
      throw new Error('Population retention bypassed its owned checkout');
    },
  } as unknown as Pool;
}

function queryBytes(query: NativeQuery): number {
  return Buffer.byteLength(query.text) + Buffer.byteLength(encode(query.values));
}

test('population start/final retention bounds native custody and replays the durable result at unchanged cost', async () => {
  const routeKey = Uint8Array.from([7, 11, 13]);
  const startId = randomUUID();
  const executionId = randomUUID();
  const bootstrapId = randomUUID();
  const start: PrivacyReductionStart = { observation: `population:${startId}` };
  const queried = {
    snapshot: { kind: 'pit', observation: `0:${randomUUID()}` },
    consumer: {
      physicalTarget: randomUUID(),
      incarnation: randomUUID(),
      consumerGeneration: randomUUID(),
      projectionGeneration: randomUUID(),
      meaningDigest: 'release',
      readDefinition: 'definition',
    },
  } as PopulationRequest['queried'];
  const request = (deadline: number): PopulationRequest => ({
    kind: 'population', queried, start, execution: executionId, context: { deadline },
  });
  const startRequest = (deadline: number): PopulationRequest => ({
    kind: 'population', queried, start: null, context: { deadline },
  });
  const capture = { after: null };
  const definition = {
    readDefinition: 'definition',
    source: { id: 'source', partition: 0, epoch: 1, configuration: 'configuration' },
    meaning: { digest: 'release', type: 'subject' },
    capture,
    dependencyKeys: [],
  };
  const row = {
    observation: queried.snapshot.observation,
    registration: randomUUID(),
    queried: encode(queried),
    covered: encode({ observation: `0:${bootstrapId}` }),
    consumer: encode(queried.consumer),
    definition: encode({ digest: createHash('sha256').update(encode(definition)).digest('hex'), data: definition }),
    coverage_generation: 'generation',
    incarnation: queried.consumer.incarnation,
    bootstrap: bootstrapId,
    read_definition: 'definition',
    bootstrap_consumer: encode(queried.consumer),
    snapshot_kind: queried.snapshot.kind,
    covered_generation: 'generation',
    coverage_root: 'root',
    source_id: 'source',
    configuration: 'configuration',
    owner_epoch: 1,
    route_digest: createHash('sha256').update(routeKey).digest('hex'),
    release_digest: 'release',
    subject_type: 'subject',
    capture: encode(capture),
    dependency_keys: [],
    coverage_keys: publicFilterCoverageKeys([]),
    execution: null,
    consumer_window: null,
    start_id: startId,
    start_generation: 'generation',
    start_deadline: '0',
    pending: false,
    fenced: false,
    admitted: true,
    inserted_start: null,
    started_page: null,
    finished_page: null,
    page_id: startId,
    page_state: 'finished',
    page_rounds: 1,
    page_charged: 0,
    page_ceiling: 200,
    page_tail: executionId,
    tail_consumed: 0,
    boundary: null,
    boundary_consumed: 0,
    boundary_window: null,
    page_children: [{
      id: executionId,
      execution: encode({ id: executionId, start, ownRows: [] }),
      consumer_window: encode({ raw: [], parent: null, consumed: 0, before: null, rounds: 1, charged: 0 }),
      page_ordinal: 1,
      page_parent: null,
      page_consumed: 0,
      page_size: 200,
      page_raw: 0,
      page_status: 'complete',
    }],
    heads: [],
    own_homes: 0,
    own_subjects: 0,
  };
  const fixedCost = {
    candidates: 0, accessPoints: 0, engineSearches: 0, engineIteratorSteps: 0,
    outputSlots: 0, resultWrites: 1, frontierWrites: 0,
  };

  let unexpectedCheckouts = 0;
  const noCheckout = pool(() => {
    unexpectedCheckouts++;
    throw new Error('Expired work checked out a connection');
  });
  const preflight = await readPublicFilterPopulation(noCheckout, routeKey, request(Date.now() - 1), search, access);
  assert.equal(preflight.status, 'unavailable');
  if (preflight.status !== 'unavailable') return;
  assert.equal(preflight.reason, 'deadline');
  assert.equal(unexpectedCheckouts, 0);
  assert.deepEqual(preflight.cost, {
    ...fixedCost, resultWrites: 0, inputKeys: 64, dependencyPoints: 32,
    statements: 0, rows: 32, bytes: 0,
  });

  let completeCheckout!: (value: PoolClient) => void;
  const pendingCheckout = new Promise<PoolClient>((resolve) => { completeCheckout = resolve; });
  let lateQueries = 0;
  let lateRelease!: (error: Error | undefined) => void;
  const lateReleased = new Promise<Error | undefined>((resolve) => { lateRelease = resolve; });
  const lateClient = client(async () => {
    lateQueries++;
    throw new Error('Late checkout dispatched a query');
  }, lateRelease);
  const late = await readPublicFilterPopulation(
    pool(() => pendingCheckout), routeKey, startRequest(Date.now() + 200), search, access,
  );
  assert.equal(late.status, 'unavailable');
  if (late.status !== 'unavailable') return;
  assert.equal(late.reason, 'deadline');
  assert.deepEqual({ ...late.cost, bytes: 0 }, {
    ...fixedCost, inputKeys: 1000, dependencyPoints: 504,
    statements: 1, rows: 504, bytes: 0,
  });
  assert.ok('bytes' in late.cost && typeof late.cost.bytes === 'number' && late.cost.bytes > 0);
  completeCheckout(lateClient);
  assert.equal(await lateReleased, undefined);
  assert.equal(lateQueries, 0);

  let completeNative!: (value: NativeResult) => void;
  const pendingNative = new Promise<NativeResult>((resolve) => { completeNative = resolve; });
  let retained = false;
  let stalledQuery: NativeQuery | undefined;
  let stalledRelease!: (error: Error | undefined) => void;
  const stalledReleased = new Promise<Error | undefined>((resolve) => { stalledRelease = resolve; });
  const stalledClient = client((query) => {
    stalledQuery = query;
    retained = true; // Native completion is unknown to the caller, but retention committed.
    return pendingNative;
  }, stalledRelease);
  const stalled = await readPublicFilterPopulation(
    pool(async () => stalledClient), routeKey, request(Date.now() + 200), search, access,
  );
  assert.equal(stalled.status, 'unavailable');
  if (stalled.status !== 'unavailable') return;
  assert.equal(stalled.reason, 'deadline');
  assert.ok(stalledQuery);
  assert.match(stalledQuery.text, /^\/\* semantic\.privacy-final \*\//);
  assert.equal(stalledQuery.values[8], executionId);
  assert.equal(stalledQuery.values[9], startId);
  assert.equal(stalledQuery.values[11], null);
  assert.ok((await stalledReleased) instanceof Error);
  assert.deepEqual(stalled.cost, {
    ...fixedCost, inputKeys: 1000, dependencyPoints: 504,
    statements: 1, rows: 504, bytes: queryBytes(stalledQuery),
  });
  completeNative({ rows: [{ ...row, page_state: 'sealed', finished_page: startId }] });

  let replayQuery: NativeQuery | undefined;
  let replayReleases = 0;
  const replayClient = client(async (query) => {
    replayQuery = query;
    assert.equal(retained, true);
    return { rows: [row] };
  }, (error) => {
    assert.equal(error, undefined);
    replayReleases++;
  });
  const replay = await readPublicFilterPopulation(
    pool(async () => replayClient), routeKey, request(Date.now() + 1000), search, access,
  );
  assert.equal(replay.status, 'observed');
  if (replay.status !== 'observed') return;
  assert.deepEqual(replay.start, start);
  assert.deepEqual(replay.blocking, []);
  assert.equal(replayReleases, 1);
  assert.ok(replayQuery);
  assert.equal(replayQuery.values[8], stalledQuery.values[8]);
  assert.equal(replayQuery.values[9], stalledQuery.values[9]);
  assert.deepEqual(replay.cost, {
    ...fixedCost, inputKeys: 64 + row.coverage_keys.length, dependencyPoints: 32,
    statements: 1, rows: 32, bytes: queryBytes(replayQuery) + Buffer.byteLength(encode([row])),
  });

  const serverError = Object.assign(new Error('settled PostgreSQL rejection'), { code: '23505', severity: 'ERROR' });
  let serverReleaseCount = 0;
  const serverClient = client(async () => { throw serverError; }, (error) => {
    assert.equal(error, undefined);
    serverReleaseCount++;
  });
  const serverDeadline = Date.now() + 1000;
  const originalNow = Date.now;
  const laterClockAccess = {
    ...access,
    classifyUnavailability(error: unknown) {
      if (error === serverError) Date.now = () => serverDeadline + 1;
      return undefined;
    },
  } as PublicFilterAccessBindingPort;
  try {
    const rejected = await readPublicFilterPopulation(
      pool(async () => serverClient), routeKey, request(serverDeadline), search, laterClockAccess,
    );
    assert.equal(rejected.status, 'unavailable');
    if (rejected.status === 'unavailable') assert.equal(rejected.reason, 'dependency_unavailable');
    assert.equal(serverReleaseCount, 1);
  } finally {
    Date.now = originalNow;
  }

  const transportError = Object.assign(new Error('native response lost'), { code: 'ECONNRESET' });
  let transportRelease: Error | undefined;
  const transportClient = client(async () => { throw transportError; }, (error) => { transportRelease = error; });
  const transport = await readPublicFilterPopulation(
    pool(async () => transportClient), routeKey, request(Date.now() + 1000), search, access,
  );
  assert.equal(transport.status, 'unavailable');
  if (transport.status === 'unavailable') assert.equal(transport.reason, 'dependency_unavailable');
  assert.equal(transportRelease, transportError);
});
