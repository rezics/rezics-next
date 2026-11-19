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
import { explainPlanEntries } from '../support/growth-plan-walk.ts';
import { checkGrowth, costOf } from '../support/growth.ts';
import { bookGrowthPublicationWindow, createBookComposition } from './support/book-composition.ts';
import { captureComposedPage } from './support/composed-page-cost.ts';

const privacyPlan = (text: string) => /^\s*\/\* semantic\.privacy-(start|final) \*\//.test(text);

// Use the installed Book journey's single setup window for publication before growth capture.
const setupMs = 600_000;
const cleanupMs = 180_000;
// The original case allowance includes one publication wait per scale.
const additionalPublicationWindows = SCALES.slice(1).reduce(
  (count, to, index) => count + Math.ceil((to - SCALES[index]!) / bookGrowthPublicationWindow.records) - 1,
  0,
);
const caseMs = 600_000 + additionalPublicationWindows * bookGrowthPublicationWindow.milliseconds;
let world: Awaited<ReturnType<typeof createBookComposition>>;
beforeAll(async () => {
  world = await createBookComposition(Date.now() + setupMs, cleanupMs);
}, setupMs + cleanupMs);
afterAll(async () => {
  await world?.close(Date.now() + cleanupMs);
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

test(
  'published Book, Series and Edition lists serve 128 disclosed slots within one native page budget as the catalogue grows',
  async () => {
    await world.denied();
    const report = await checkGrowth(world.database, {
      name: 'Released Book catalogue composition',
      scales: SCALES,
      bounds: growthSeriesBounds,
      byteBounds: growthByteBounds,
      includeBackends: true,
      captureMode: 'cost-folded',
      retainForegroundPlan: privacyPlan,
      repetitions: 1,
      grow: (_db, scale, previous) => world.grow(previous, scale),
      warmupSettlementOnly: true,
      async warmup() {
        await world.read('anonymous', true);
        // The measured request uses the already-published native generation.
        await world.pauseBackgroundWork();
      },
      operation: measurePage,
      async verify(_db, scale, _repetition, value, capture) {
        const measured = value as Awaited<ReturnType<typeof measurePage>>;
        const cost = costOf(capture);
        expect(
          cost.statements,
          `Native statement count at catalogue scale ${scale} (examined ${cost.rows}/${measured.rowLimit} rows)`,
        ).toBeLessThanOrEqual(composedLimitBound.statements);
        expect(cost.rows).toBeLessThanOrEqual(measured.rowLimit);
        expect(cost.blocks).toBeLessThanOrEqual(6 * measured.rowLimit);
        assert(cost.requestBytes !== undefined && cost.responseBytes !== undefined);
        expect(cost.requestBytes + measured.engineRequestBytes).toBeLessThanOrEqual(measured.requestLimit);
        expect(cost.responseBytes + measured.engineResponseBytes).toBeLessThanOrEqual(measured.responseLimit);
      },
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
    for (const { occurrenceRepetitions } of report.samples) {
      for (const { statements, retainedForegroundPlans } of occurrenceRepetitions) {
        const coverage = statements.filter(({ statement }) => privacyPlan(statement));
        expect(retainedForegroundPlans).toHaveLength(2);
        for (const role of ['start', 'final']) {
          const observed = coverage.filter(({ statement }) => statement.startsWith(`/* semantic.privacy-${role} */`));
          expect(observed).toHaveLength(1);
          const occurrence = observed[0]!;
          const documents = retainedForegroundPlans.filter(({ owner }) => owner === occurrence.index);
          expect(documents).toHaveLength(1);
          const plan = documents[0]!;
          expect(occurrence.plans).toContain(plan.index);
          expect(occurrence.error).toBeNull();
          expect(occurrence.backend).toEqual(expect.any(Number));
          expect(plan.backend).toBe(occurrence.backend);
          expect(plan.statement?.trimStart().startsWith(`/* semantic.privacy-${role} */`)).toBe(true);
          expect(explainPlanEntries(plan.document).map(({ queryText }) => queryText)).toEqual([plan.statement]);
        }
        // All writes and their indexing precede the read. No reduction arrives during the measured page.
        expect(coverage.reduce((n, entry) => n + entry.rows, 0)).toBeLessThanOrEqual(
          composedLimitBound.privacyExaminedRows(0),
        );
      }
    }
  },
  caseMs,
);
