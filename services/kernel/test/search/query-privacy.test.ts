import { expect, test } from 'bun:test';
import {
  admitQueryPrivacyCursor,
  admitQueryPrivacyHeads,
  observationIsDisclosable,
  queryPrivacyCurrentness,
  queryPrivacyKindWitness,
  queryPrivacyProofKind,
  queryPrivacyProofs,
  replayQueryPrivacyCursor,
  sampledHitsCannotCertifyTotal,
  trustedStaleObservation,
} from '../../src/search/query-privacy.ts';
import {
  consumerObservationIsDisclosable,
  observationIsDisclosableFromUnknown,
  sourceObservationIsDisclosable,
} from '../../src/search/query-privacy-observation.ts';
import { createQueryPrivacyConsumer } from '../../src/search/query-privacy-consumer.ts';
import type {
  PublicFilterConsumerOperations,
  PublicFilterConsumerStatus,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { PrivacyReductionObservation } from '../../src/semantic/index.ts';
import { privacyBarrier, privacyHead, privacyHeads } from './support/query-privacy-heads.ts';

const book = 'schema:Book';
const cost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};

test('irrelevant unacknowledged and changed heads are trusted stale and remain disclosable', () => {
  const heads = privacyHeads({
    unacknowledged: [privacyHead(2)],
    changed: [privacyHead(3, 4n)],
  });
  const decision = queryPrivacyCurrentness(heads);
  expect(decision).toEqual({
    status: 'current',
    stale: true,
    unacknowledged: heads.unacknowledged,
    changed: heads.changed,
  });
  expect(observationIsDisclosable(heads)).toBe(true);
  expect(trustedStaleObservation(decision)).toBe(true);
  expect(observationIsDisclosableFromUnknown(heads)).toBe(true);
});

test('a relevant blocking reduction prepares even after live pending is empty', () => {
  const heads = privacyHeads({
    unacknowledged: [],
    changed: [privacyHead()],
    blocking: [privacyBarrier({ phase: 'changed' })],
  });
  expect(queryPrivacyCurrentness(heads)).toEqual({ status: 'preparing', reason: 'blocking' });
  expect(observationIsDisclosable(heads)).toBe(false);
});

test('incomplete routing never becomes a clean checkpoint', () => {
  expect(queryPrivacyCurrentness(privacyHeads({ routingComplete: false }))).toEqual({
    status: 'preparing',
    reason: 'routing_incomplete',
  });
  expect(
    sourceObservationIsDisclosable({
      status: 'observed',
      coverage: 'all_native_homes',
      start: { observation: 'obs' },
      unacknowledged: [],
      changed: [],
      routingComplete: false,
      blocking: [],
      cost,
    }),
  ).toBe(false);
});

test('an admitted cursor, kind witness and exact aggregate stay independent proofs', () => {
  const currentness = queryPrivacyCurrentness(privacyHeads());
  const proofs = queryPrivacyProofs({
    currentness,
    cursor: { observation: 'obs', execution: 'exec', consumed: 2 },
    kinds: [book],
    witnesses: new Map([[book, 3]]),
    continuation: false,
    exhausted: true,
    aggregateProof: true,
  });
  expect(proofs.cursor).toEqual(admitQueryPrivacyCursor({ observation: 'obs', execution: 'exec', consumed: 2 }));
  expect(proofs.kinds.get(book)?.evidence).toEqual({ kind: book, value: 3, exact: false });
  expect(proofs.aggregates.get(book)?.evidence).toEqual({ kind: book, value: 3, exact: true });
  expect(queryPrivacyProofKind(proofs.cursor!)).toBe('admitted-cursor');
  expect(queryPrivacyProofKind(proofs.kinds.get(book)!)).toBe('kind-witness');
  expect(queryPrivacyProofKind(proofs.aggregates.get(book)!)).toBe('exact-aggregate');
});

test('sampled hits and continuations never certify an exact total', () => {
  const currentness = queryPrivacyCurrentness(privacyHeads());
  const sample = queryPrivacyProofs({
    currentness,
    kinds: [book],
    witnesses: new Map([[book, 2]]),
    continuation: false,
    exhausted: false,
    aggregateProof: false,
  });
  expect(sample.aggregates.size).toBe(0);
  expect(sample.kinds.get(book)?.evidence).toEqual({ kind: book, value: 2, exact: false });
  expect(
    sampledHitsCannotCertifyTotal({
      continuation: false,
      exhausted: false,
      aggregateProof: false,
      witnesses: new Map([[book, 2]]),
    }),
  ).toBe(true);
  const continued = queryPrivacyProofs({
    currentness,
    cursor: { observation: 'obs', consumed: 1 },
    kinds: [book],
    witnesses: new Map([[book, 4]]),
    continuation: true,
    exhausted: true,
    aggregateProof: true,
  });
  expect(continued.kinds.get(book)?.evidence).toEqual({ kind: book, unavailable: true });
  expect(continued.aggregates.size).toBe(0);
});

test('cursor replay restarts on a relevant reduction and continues when trusted stale', () => {
  const admitted = admitQueryPrivacyCursor({ observation: 'obs', consumed: 1 });
  expect(replayQueryPrivacyCursor(admitted, queryPrivacyCurrentness(privacyHeads()))).toBe('continue');
  expect(
    replayQueryPrivacyCursor(admitted, queryPrivacyCurrentness(privacyHeads({ unacknowledged: [privacyHead()] }))),
  ).toBe('continue');
  expect(
    replayQueryPrivacyCursor(admitted, queryPrivacyCurrentness(privacyHeads({ blocking: [privacyBarrier()] }))),
  ).toBe('restart');
});

test('consumer status uses pending as unacknowledged heads', () => {
  const status: PublicFilterConsumerStatus = {
    status: 'observed',
    queried: {
      consumer: {
        physicalTarget: 'subjects-g1',
        incarnation: 'uuid',
        consumerGeneration: '1',
        projectionGeneration: '1',
        meaningDigest: 'd',
        readDefinition: 'r',
      },
      snapshot: { kind: 'pit', observation: 'obs', pit: 'pit' },
    },
    covered: { observation: 'obs' },
    pending: [privacyHead()],
    changed: [],
    blocking: [],
    cost,
  };
  expect(consumerObservationIsDisclosable(status)).toBe(true);
});

test('the acknowledgement consumer withholds a queried page whose final observation is blocking', async () => {
  const queried = {
    consumer: {
      physicalTarget: 'subjects-g1',
      incarnation: 'uuid',
      consumerGeneration: '1',
      projectionGeneration: '1',
      meaningDigest: 'd',
      readDefinition: 'r',
    },
    snapshot: { kind: 'pit' as const, observation: 'obs', pit: 'pit' },
  };
  const operations = {
    async query() {
      return {
        status: 'queried' as const,
        queried,
        execution: 'exec',
        start: { observation: 'obs' },
        result: { hits: [], total: { value: 0, relation: 'eq' as const } },
        window: { positions: [], examined: 0, exhausted: true },
        cost,
      };
    },
    async readStatus() {
      return {
        status: 'observed' as const,
        queried,
        covered: { observation: 'obs' },
        pending: [],
        changed: [privacyHead()],
        blocking: [privacyBarrier({ phase: 'changed' })],
        cost,
      };
    },
  } as unknown as PublicFilterConsumerOperations;
  const result = await createQueryPrivacyConsumer(operations).query(queried, { deadline: Date.now() + 1_000 });
  expect(result.status).toBe('preparing');
  expect(result).toMatchObject({ currentness: { status: 'preparing', reason: 'blocking' } });
});

test('malformed privacy heads fail closed', () => {
  expect(() =>
    admitQueryPrivacyHeads({ routingComplete: true, unacknowledged: [], changed: [], blocking: [{}] }),
  ).toThrow(TypeError);
});

test('a Source observed result with no barriers is current', () => {
  const observed: PrivacyReductionObservation = {
    status: 'observed',
    coverage: 'all_native_homes',
    start: { observation: 'obs' },
    unacknowledged: [],
    changed: [],
    routingComplete: true,
    blocking: [],
    cost,
  };
  expect(sourceObservationIsDisclosable(observed)).toBe(true);
});

test('kind witnesses without aggregate proof stay lower bounds', () => {
  expect(
    queryPrivacyKindWitness(book, {
      continuation: false,
      exhausted: true,
      aggregateProof: false,
      witnesses: new Map([[book, 1]]),
    }).evidence,
  ).toEqual({ kind: book, value: 1, exact: false });
});
