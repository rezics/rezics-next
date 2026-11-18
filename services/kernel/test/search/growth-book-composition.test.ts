import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  COMPOSED_READS,
  COMPOSED_SLOTS,
  MAX_REFILL_ROUNDS,
  READY_INDEX_READS,
  SCALES,
  composedLimitBound,
  deriveReadBound,
  growthByteBounds,
  growthSeriesBounds,
  ordinaryCountedBounds,
  planKind,
} from '../performance/support/composed-discovery-bounds.ts';
import { checkGrowth } from '../support/growth.ts';
import { createBookComposition } from './support/book-composition.ts';
import { captureComposedPage } from './support/composed-page-cost.ts';

// Use the installed Book journey's single setup window for publication before growth capture.
const setupMs = 600_000;
const cleanupMs = 180_000;
let world: Awaited<ReturnType<typeof createBookComposition>>;
beforeAll(async () => {
  world = await createBookComposition(Date.now() + setupMs);
}, setupMs + cleanupMs);
afterAll(async () => {
  await world?.close();
}, cleanupMs);

async function measurePage() {
  const { sample, value: outputSlots } = await captureComposedPage(() => world.read('anonymous'));
  expect(sample.reads).toHaveLength(COMPOSED_READS);
  let candidates = 0;
  let accessDependencies = 0;
  let slots = 0;
  let engineLimit = 0;
  let rowLimit = 0;
  let requestLimit = 0;
  let responseLimit = 0;
  for (const read of sample.reads) {
    const cost = read.cost;
    assert(cost, 'TypeList completed without executing its native coverage page');
    expect(read.finished).toBe(true);
    const bound = deriveReadBound(planKind(read.snapshot), read.slots);
    expect(read.rounds).toBeGreaterThan(0);
    expect(read.rounds).toBeLessThanOrEqual(read.snapshot === 'pit' ? MAX_REFILL_ROUNDS : READY_INDEX_READS);
    expect(cost.candidates).toBeGreaterThanOrEqual(read.slots);
    expect(cost.candidates).toBeLessThanOrEqual(bound.candidates);
    expect(cost.accessPoints + cost.dependencyPoints).toBeLessThanOrEqual(
      bound.accessDependencyPoints(cost.candidates),
    );
    expect(cost.engineSearches).toBeLessThanOrEqual(bound.engineSearches);
    candidates += cost.candidates;
    accessDependencies += cost.accessPoints + cost.dependencyPoints;
    slots += read.slots;
    engineLimit += bound.engineSearches;
    rowLimit += bound.examinedRows(cost.candidates);
    requestLimit += bound.requestBytes(cost.candidates);
    responseLimit += bound.responseBytes(cost.candidates);
  }
  expect(slots).toBe(COMPOSED_SLOTS);
  expect(outputSlots).toBe(slots);
  expect(sample.engineSearches).toBeLessThanOrEqual(engineLimit);
  return {
    candidates,
    accessDependencies,
    outputSlots,
    engineSearches: sample.engineSearches,
    iteratorSteps: sample.iteratorSteps,
    rowLimit,
    requestLimit,
    responseLimit,
    engineRequestBytes: sample.requestBytes,
    engineResponseBytes: sample.responseBytes,
  };
}

test('published Book, Series and Edition lists serve 128 disclosed slots within one native page budget as the catalogue grows', async () => {
  await world.denied();
  const report = await checkGrowth(world.database, {
    name: 'Released Book catalogue composition',
    scales: SCALES,
    bounds: growthSeriesBounds,
    byteBounds: growthByteBounds,
    includeBackends: true,
    repetitions: 1,
    grow: (_db, scale, previous) => world.grow(previous, scale),
    async warmup() {
      await world.read('alice', true);
      await world.read('anonymous', true);
    },
    operation: measurePage,
    counted: {
      read: (value) => value as Awaited<ReturnType<typeof measurePage>>,
      limits: {
        candidates: composedLimitBound.candidates,
        accessDependencies: composedLimitBound.accessDependencyPoints,
        outputSlots: COMPOSED_SLOTS,
        engineSearches: composedLimitBound.engineSearches,
        connections: composedLimitBound.connections,
      },
      bounds: { ...ordinaryCountedBounds, engineRequestBytes: 'constant', engineResponseBytes: 'constant' },
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
  for (const { cost, counted, occurrenceRepetitions } of report.samples) {
    assert(counted && cost.requestBytes !== undefined && cost.responseBytes !== undefined);
    const rows = counted.rowLimit!.value;
    expect(cost.rows).toBeLessThanOrEqual(rows);
    expect(cost.blocks).toBeLessThanOrEqual(6 * rows);
    expect(cost.statements).toBeLessThanOrEqual(composedLimitBound.statements);
    expect(cost.requestBytes + counted.engineRequestBytes!.value).toBeLessThanOrEqual(counted.requestLimit!.value);
    expect(cost.responseBytes + counted.engineResponseBytes!.value).toBeLessThanOrEqual(counted.responseLimit!.value);
    for (const { statements } of occurrenceRepetitions) {
      const coverage = statements.filter(({ statement }) =>
        /^\/\* semantic\.privacy-(start|final) \*\//.test(statement),
      );
      for (const role of ['start', 'final']) {
        const observed = coverage.filter(({ statement }) => statement.startsWith(`/* semantic.privacy-${role} */`));
        expect(observed).toHaveLength(1);
        expect(observed[0]!.plans.length).toBeGreaterThan(0);
      }
      // All writes and their indexing precede the read. No reduction arrives during the measured page.
      expect(coverage.reduce((n, entry) => n + entry.rows, 0)).toBeLessThanOrEqual(
        composedLimitBound.privacyExaminedRows(0),
      );
    }
  }
}, 600_000);
