import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { newId } from '../../src/route/route.ts';
import { Admission } from '../../src/http/admission.ts';
import { readPage } from '../../src/presentation/reads.ts';
import { readBookIdentities, type BookIdentityRead } from '../../src/search/composed-book-identities.ts';
import { bookPageObservation, runBookCatalogueRead } from '../../src/search/composed-book-reads.ts';
import { createNativePublicFilterSource } from '../../src/semantic/public-filter-source.ts';
import {
  publicFilterCoverageStart,
  withPublicFilterCoverageStarts,
} from '../../src/search/public-filter-coverage-page.ts';
import { publicFilterCoverageKeys } from '../../src/semantic/public-filter-coverage-pending.ts';
import {
  readPublicFilterPagePopulations,
  readPublicFilterPopulation,
} from '../../src/semantic/public-filter-coverage-population.ts';
import type {
  PrivacyReductionObservation,
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

function client(query: (config: NativeQuery) => Promise<NativeResult>, release: (error?: Error) => void): PoolClient {
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

test('one composed START releases only the native page contexts it enrolled', async () => {
  const first = { context: { deadline: Date.now() + 1000 }, id: randomUUID() };
  const second = { context: { deadline: first.context.deadline }, id: randomUUID() };
  await withPublicFilterCoverageStarts([first], async () => {
    await assert.rejects(
      withPublicFilterCoverageStarts([second, first], async () => assert.fail('A partial cohort dispatched')),
      /Concurrent native coverage starts/,
    );
    assert.equal(publicFilterCoverageStart(first.context), first.id);
    assert.equal(publicFilterCoverageStart(second.context), null);
  });
  await assert.rejects(
    withPublicFilterCoverageStarts([first, second], async () => {
      assert.equal(publicFilterCoverageStart(first.context), first.id);
      assert.equal(publicFilterCoverageStart(second.context), second.id);
      throw new Error('Source unavailable');
    }),
    /Source unavailable/,
  );
  assert.equal(publicFilterCoverageStart(first.context), null);
  assert.equal(publicFilterCoverageStart(second.context), null);
});

function populationFixture() {
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
    kind: 'population',
    queried,
    start,
    execution: executionId,
    context: { deadline },
  });
  const startRequest = (deadline: number): PopulationRequest => ({
    kind: 'population',
    queried,
    start: null,
    context: { deadline },
  });
  const capture = { after: null, bookTypeList: true };
  const definition = {
    readDefinition: 'definition',
    source: { id: 'source', partition: 0, epoch: 1, configuration: 'configuration' },
    meaning: { digest: 'release', release: { types: { subject: {} } } },
    capture,
    dependencyKeys: [],
  };
  const row = {
    slot: 0,
    book_withdrawals: null,
    own_births: 0,
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
    page_ceiling: 39,
    page_tail: executionId,
    tail_consumed: 0,
    boundary: null,
    boundary_consumed: 0,
    boundary_window: null,
    page_children: [
      {
        id: executionId,
        execution: encode({ id: executionId, start, ownRows: [] }),
        consumer_window: encode({ raw: [], parent: null, consumed: 0, before: null, rounds: 1, charged: 0 }),
        page_ordinal: 1,
        page_parent: null,
        page_consumed: 0,
        page_size: 200,
        page_raw: 0,
        page_status: 'complete',
      },
    ],
    heads: [],
    own_homes: 0,
    own_subjects: 0,
  };
  return { routeKey, startId, executionId, start, queried, request, startRequest, row };
}

test('population start/final retention bounds native custody and replays the durable result at unchanged cost', async () => {
  const { routeKey, startId, executionId, start, queried, request, startRequest, row } = populationFixture();
  const fixedCost = {
    candidates: 0,
    accessPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 1,
    frontierWrites: 0,
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
    ...fixedCost,
    resultWrites: 0,
    inputKeys: 64,
    dependencyPoints: 32,
    statements: 0,
    rows: 32,
    bytes: 0,
  });

  let completeCheckout!: (value: PoolClient) => void;
  const pendingCheckout = new Promise<PoolClient>((resolve) => {
    completeCheckout = resolve;
  });
  let lateQueries = 0;
  let lateRelease!: (error: Error | undefined) => void;
  const lateReleased = new Promise<Error | undefined>((resolve) => {
    lateRelease = resolve;
  });
  const lateClient = client(async () => {
    lateQueries++;
    throw new Error('Late checkout dispatched a query');
  }, lateRelease);
  const late = await readPublicFilterPopulation(
    pool(() => pendingCheckout),
    routeKey,
    startRequest(Date.now() + 200),
    search,
    access,
  );
  assert.equal(late.status, 'unavailable');
  if (late.status !== 'unavailable') return;
  assert.equal(late.reason, 'deadline');
  assert.deepEqual(
    { ...late.cost, bytes: 0 },
    {
      ...fixedCost,
      inputKeys: 1000,
      dependencyPoints: 504,
      statements: 1,
      rows: 504,
      bytes: 0,
    },
  );
  assert.ok('bytes' in late.cost && typeof late.cost.bytes === 'number' && late.cost.bytes > 0);
  completeCheckout(lateClient);
  assert.equal(await lateReleased, undefined);
  assert.equal(lateQueries, 0);

  let completeNative!: (value: NativeResult) => void;
  const pendingNative = new Promise<NativeResult>((resolve) => {
    completeNative = resolve;
  });
  let retained = false;
  let stalledQuery: NativeQuery | undefined;
  let stalledRelease!: (error: Error | undefined) => void;
  const stalledReleased = new Promise<Error | undefined>((resolve) => {
    stalledRelease = resolve;
  });
  const stalledClient = client((query) => {
    stalledQuery = query;
    retained = true; // Native completion is unknown to the caller, but retention committed.
    return pendingNative;
  }, stalledRelease);
  const stalled = await readPublicFilterPopulation(
    pool(async () => stalledClient),
    routeKey,
    request(Date.now() + 200),
    search,
    access,
  );
  assert.equal(stalled.status, 'unavailable');
  if (stalled.status !== 'unavailable') return;
  assert.equal(stalled.reason, 'deadline');
  assert.ok(stalledQuery);
  assert.match(stalledQuery.text, /^\/\* semantic\.privacy-final \*\//);
  const [binding] = JSON.parse(String(stalledQuery.values[0]));
  assert.equal(binding.execution_id, executionId);
  assert.equal(binding.start_id, startId);
  assert.equal(binding.page_id, null);
  assert.ok((await stalledReleased) instanceof Error);
  assert.deepEqual(stalled.cost, {
    ...fixedCost,
    inputKeys: 1000,
    dependencyPoints: 504,
    statements: 1,
    rows: 504,
    bytes: queryBytes(stalledQuery),
  });
  completeNative({ rows: [{ ...row, page_state: 'sealed', finished_page: startId }] });

  let replayQuery: NativeQuery | undefined;
  let replayReleases = 0;
  const replayClient = client(
    async (query) => {
      replayQuery = query;
      assert.equal(retained, true);
      return { rows: [row] };
    },
    (error) => {
      assert.equal(error, undefined);
      replayReleases++;
    },
  );
  const replay = await readPublicFilterPopulation(
    pool(async () => replayClient),
    routeKey,
    request(Date.now() + 1000),
    search,
    access,
  );
  assert.equal(replay.status, 'observed');
  if (replay.status !== 'observed') return;
  assert.deepEqual(replay.start, start);
  assert.deepEqual(replay.blocking, []);
  assert.equal(replayReleases, 1);
  assert.ok(replayQuery);
  const [replayed] = JSON.parse(String(replayQuery.values[0]));
  assert.equal(replayed.execution_id, binding.execution_id);
  assert.equal(replayed.start_id, binding.start_id);
  assert.deepEqual(replay.cost, {
    ...fixedCost,
    inputKeys: 64 + row.coverage_keys.length,
    dependencyPoints: 32,
    statements: 1,
    rows: 32,
    bytes: queryBytes(replayQuery) + Buffer.byteLength(encode([row])),
  });

  // A matching population can't substitute the first page's finish for another
  // execution. Exercise the response mapping after the single native dispatch.
  const sibling: PopulationRequest = {
    ...request(Date.now() + 1000),
    start: { observation: `population:${randomUUID()}` },
    execution: randomUUID(),
    queried: { ...queried, snapshot: { ...queried.snapshot, observation: `0:${randomUUID()}` } },
  };
  let dispatches = 0;
  const crossedClient = client(
    async (query) => {
      if (query.text.startsWith('BEGIN') || query.text === 'SET LOCAL enable_seqscan = off' || query.text === 'COMMIT')
        return { rows: [] };
      if (query.text.startsWith('/* semantic.privacy-final */')) {
        dispatches++;
        return { rows: [{ generation: '1', pending: false, fenced: false, heads: [] }] };
      }
      const submitted: { execution_id: string }[] = JSON.parse(String(query.values[0]));
      assert.deepEqual(
        submitted.map((member) => member.execution_id),
        [executionId, sibling.execution],
      );
      return { rows: [row, { ...row, slot: 1, queried: encode(sibling.queried) }] };
    },
    () => {},
  );
  const crossed = await readPublicFilterPagePopulations(
    pool(async () => crossedClient),
    routeKey,
    [request(Date.now() + 1000), sibling],
    search,
    access,
  );
  assert.equal(dispatches, 1);
  assert.deepEqual(
    crossed.map((member) => member.status),
    ['observed', 'unready'],
  );
  assert.deepEqual(
    crossed.map((member) => 'statements' in member.cost && member.cost.statements),
    [5, 0],
  );
  const duplicate = await readPublicFilterPagePopulations(noCheckout, routeKey, [sibling, sibling], search, access);
  assert.deepEqual(
    duplicate.map((member) => member.status),
    ['unready', 'unready'],
  );
  assert.equal(unexpectedCheckouts, 0);

  const serverError = Object.assign(new Error('settled PostgreSQL rejection'), { code: '23505', severity: 'ERROR' });
  let serverReleaseCount = 0;
  const serverClient = client(
    async () => {
      throw serverError;
    },
    (error) => {
      assert.equal(error, undefined);
      serverReleaseCount++;
    },
  );
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
      pool(async () => serverClient),
      routeKey,
      request(serverDeadline),
      search,
      laterClockAccess,
    );
    assert.equal(rejected.status, 'unavailable');
    if (rejected.status === 'unavailable') assert.equal(rejected.reason, 'dependency_unavailable');
    assert.equal(serverReleaseCount, 1);
  } finally {
    Date.now = originalNow;
  }

  const transportError = Object.assign(new Error('native response lost'), { code: 'ECONNRESET' });
  let transportRelease: Error | undefined;
  const transportClient = client(
    async () => {
      throw transportError;
    },
    (error) => {
      transportRelease = error;
    },
  );
  const transport = await readPublicFilterPopulation(
    pool(async () => transportClient),
    routeKey,
    request(Date.now() + 1000),
    search,
    access,
  );
  assert.equal(transport.status, 'unavailable');
  if (transport.status === 'unavailable') assert.equal(transport.reason, 'dependency_unavailable');
  assert.equal(transportRelease, transportError);
});

test('overlapping Book windows check each current original and terminal once and refuse the affected tail', async () => {
  const plans = [populationFixture(), populationFixture()];
  const subjects = Array.from({ length: 13 }, (_, index) => newId(index * 16));
  const redirected = newId(16);
  const deadline = Date.now() + 1000;
  const finish: string[] = [];
  const sqlRoles: string[] = [];
  const queried = plans.map((p) => ({ ...p.queried, consumer: plans[0]!.queried.consumer }));
  const rows = plans.map((p, i) => {
    const ids = i === 0 ? subjects : subjects.slice(1);
    const ownRows = ids.map((id) => ({ original: id, terminal: id === subjects[0] ? redirected : id }));
    const child = p.row.page_children[0]!;
    const parent = i === 1 ? randomUUID() : null;
    const consumed = parent === null ? 0 : 1;
    const previous = { raw: [{ id: subjects[0], sort: [subjects[0]] }], before: null, consumed: 0 };

    return {
      ...p.row,
      slot: i,
      queried: encode(queried[i]),
      consumer: encode(queried[i]!.consumer),
      bootstrap_consumer: encode(queried[i]!.consumer),
      page_state: 'sealed',
      boundary: parent,
      boundary_consumed: consumed,
      boundary_window: parent === null ? null : encode(previous),
      page_charged: ids.length,
      page_children: [
        {
          ...child,
          page_parent: parent,
          page_consumed: consumed,
          page_raw: ids.length,
          execution: encode({ id: p.executionId, start: p.start, ownRows }),
          consumer_window: encode({
            raw: ids.map((id) => ({ id, sort: [id] })),
            parent,
            consumed,
            before: parent === null ? null : previous.raw[0]!.sort,
            rounds: 1,
            charged: ids.length,
          }),
        },
      ],
    };
  });
  const db = pool(async () =>
    client(
      async (query) => {
        if (query.text.startsWith('-- Bind')) return { rows };
        if (query.text.startsWith('/* semantic.privacy-final */')) {
          sqlRoles.push('final');
          return {
            rows: [
              {
                pending: false,
                fenced: false,
                heads: [],
                coverage_registration: 'registration',
                coverage_bootstrap: plans[0]!.startId,
                generation: '1',
              },
            ],
          };
        }
        if (query.text.startsWith('/* semantic.own-rows */')) {
          sqlRoles.push('own');
          const [ids, homes] = query.values as [string[], number[]];
          assert.deepEqual(new Set(ids), new Set([...subjects, redirected]));
          assert.equal(ids.length, 14);
          assert.equal(new Set(homes).size, 13);
          return { rows: ids.map((id) => ({ id, admitted: id !== redirected, check_birth: false })) };
        }
        if (query.text.startsWith('UPDATE search.public_filter_coverage_page')) {
          finish.push(...(query.values[0] as string[]));
          return { rows: finish.map((id) => ({ id })) };
        }
        assert(
          query.text.startsWith('BEGIN') || query.text === 'SET LOCAL enable_seqscan = off' || query.text === 'COMMIT',
        );
        return { rows: [] };
      },
      () => {},
    ),
  );
  const result = await readPublicFilterPagePopulations(
    db,
    plans[0]!.routeKey,
    plans.map((p, i) => ({ ...p.request(deadline), queried: queried[i]! })),
    search,
    access,
  );
  assert.deepEqual(
    result.map((r) => r.status),
    ['unready', 'observed'],
  );
  assert.deepEqual(finish, [plans[1]!.startId]);
  assert.deepEqual(sqlRoles, ['final', 'own']);
  // Two bindings and children, one parent role, thirteen home pairs, fourteen Subjects and one finish.
  assert.equal(
    result.reduce((n, r) => n + r.cost.dependencyPoints, 0),
    2 * (7 + 1) + 32 + 2 * 13 + 14 + 1,
  );
});

test('overlapping Book identity windows retain order and charge a refused original to its requesting reads', async () => {
  const [first, shared, missing] = [randomUUID(), randomUUID(), randomUUID()] as const;
  const calls: string[] = [];
  const source = {
    async readPublicFilterSubjectIdentities({ subjects }: BookIdentityRead['request']) {
      calls.push(...subjects);
      const cost = {
        inputKeys: 2,
        candidates: 0,
        accessPoints: 1,
        dependencyPoints: 2,
        engineSearches: 0,
        engineIteratorSteps: 0,
        outputSlots: 0,
        resultWrites: 0,
        frontierWrites: 0,
      };
      if (subjects.includes(missing)) return { status: 'unready', reason: 'metadata_missing', cost };
      return {
        status: 'observed',
        rows: subjects.map((subject) => ({
          subject,
          terminal: subject,
          partition: 0,
          securityRevision: '1',
          currentRelease: 'release',
        })),
        cost,
      };
    },
  } as BookIdentityRead['source'];
  const charges = [0, 0];
  const members = [
    [shared, first],
    [missing, shared],
  ].map((subjects, i): BookIdentityRead => ({
    source,
    request: {
      subjects,
      meaning: { digest: 'release' } as BookIdentityRead['request']['meaning'],
      inputLimit: 12,
      context: { deadline: Date.now() + 1000 },
    },
    answer: Promise.withResolvers(),
    admit: (work) => work(),
    charge: (cost) => {
      charges[i]! += cost.accessPoints + cost.dependencyPoints;
    },
  }));
  const settled = await readBookIdentities(members, () => {});
  for (const read of members) settled.get(read)!();
  const [ready, refused] = await Promise.all(members.map((read) => read.answer.promise));
  assert.deepEqual(
    ready?.map((row) => row.subject),
    [shared, first],
  );
  assert.equal(refused, undefined);
  assert.deepEqual(calls.sort(), [shared, first, missing].sort());
  assert.equal(charges[0]! + charges[1]!, 9);
  assert(charges.every((points) => points >= 3));
});

test('nine Book lists yield admission through one START, bounded execution and a failed shared FINAL', async () => {
  const { row, queried, startRequest } = populationFixture();
  // Nine live plans exceed both the four page workers and the eight HTTP permits.
  // Lose the FINAL reply after all tails arrive. Every child must retain its own failure and cost.
  const admission = new Admission();
  const planned = Array.from({ length: 9 }, () => randomUUID());
  const held = new Set<string>();
  const roles: string[] = [];
  let peak = 0;
  const deadline = Date.now() + 3000;
  let members: {
    slot: number;
    queried: string;
    page_id: string | null;
    start_id: string;
    execution_id: string | null;
  }[] = [];
  const composedClient = client(
    async (query) => {
      if (
        query.text.startsWith('BEGIN') ||
        query.text === 'SET LOCAL enable_seqscan = off' ||
        query.text === 'COMMIT' ||
        query.text === 'ROLLBACK'
      )
        return { rows: [] };
      if (query.text.startsWith('-- Bind')) {
        members = JSON.parse(String(query.values[0]));
        return {
          rows: members.map((m) => ({
            ...row,
            slot: m.slot,
            queried: m.queried,
            page_id: m.start_id,
            page_children: m.execution_id
              ? [
                  {
                    ...row.page_children[0]!,
                    id: m.execution_id,
                    execution: encode({
                      id: m.execution_id,
                      start: { observation: 'population:' + m.start_id },
                      ownRows: [],
                    }),
                  },
                ]
              : [],
            page_state: m.execution_id ? 'sealed' : 'planned',
            page_tail: m.execution_id,
            page_rounds: m.execution_id ? 1 : 0,
          })),
        };
      }
      if (query.text.startsWith('WITH starts')) return { rows: members.map((m) => ({ id: m.start_id })) };
      assert.equal(admission.running.normal, 1);
      assert.deepEqual(
        members.map((member) => member.start_id),
        planned,
      );
      assert.equal(held.size, planned.length);
      if (query.text.startsWith('/* semantic.privacy-final */')) {
        roles.push('final');
        assert.deepEqual(
          members.map((member) => member.execution_id),
          planned.map((id) => 'tail-' + id),
        );
        throw Object.assign(new Error('Final reply lost'), { code: 'ECONNRESET' });
      }
      roles.push('start');
      assert.match(query.text, /^\/\* semantic\.privacy-start \*\//);
      assert.deepEqual(
        members.map((member) => member.page_id),
        planned,
      );
      return { rows: [{ generation: '1', pending: false, fenced: false, heads: [] }] };
    },
    () => {},
  );
  const unused = () => assert.fail('Unexpected owner lookup in population role');
  const source = createNativePublicFilterSource(
    {
      pool: pool(async () => composedClient),
      routeKey: new Uint8Array(32),
      access: { authenticate: unused, authorize: unused },
      clock: () => new Date(),
    },
    unused,
    { ...search, coverageStart: publicFilterCoverageStart },
    access,
  );
  const composed = await readPage({
    incoming: new Request('http://kernel/v1/pages:read'),
    deadline,
    session: { ring: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) }, scope: 'public' },
    reads: Object.fromEntries(
      planned.map((id, index) => [
        id,
        {
          kind: 'search',
          body: { sort: 'name', filter: { type: { in: ['schema:Book'] } }, limit: index + 1 },
        },
      ]),
    ),
    async dispatch(request) {
      const { limit } = (await request.json()) as { limit: number };
      const id = planned[limit - 1]!;
      const context = { deadline, signal: request.signal };
      return runBookCatalogueRead(admission, context, async () => {
        held.add(id);
        try {
          const charged: PrivacyReductionObservation[] = [];
          const charge = (observation: PrivacyReductionObservation) => {
            charged.push(observation);
          };
          const member = {
            ...startRequest(deadline),
            queried: {
              ...queried,
              snapshot: { ...queried.snapshot, observation: '0:' + id },
            },
          };
          const start = await bookPageObservation(source, 'publication', id, member, charge);
          assert(start?.status === 'observed' && start.start.observation === 'population:' + id);
          await new Promise<void>((resolve) => setImmediate(resolve));
          peak = Math.max(peak, admission.running.normal);
          const final = await bookPageObservation(
            source,
            'publication',
            id,
            {
              ...member,
              start: start.start,
              execution: 'tail-' + id,
            },
            charge,
          );
          assert(final?.status === 'unavailable' && final.cost.dependencyPoints === 504);
          assert.deepEqual(charged, [start, final]);
          return Response.json({ code: 'index_not_ready' }, { status: 503 });
        } finally {
          held.delete(id);
        }
      });
    },
  });
  assert.deepEqual(roles, ['start', 'final']);
  assert.equal(peak, 4);
  assert.equal(held.size, 0);
  assert.deepEqual(
    Object.values(composed.results).map((result) => result.status),
    planned.map(() => 503),
  );
});
