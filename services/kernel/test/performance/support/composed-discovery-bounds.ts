import { expect } from 'bun:test';
import type { PublicFilterCost } from '../../../src/semantic/public-filter-source-contract.ts';

/** Output slots of the suite's ordinary discovery page (`1 ≤ s ≤ 100`). */
export const PAGE_SLOTS = 2;
/** Search refill asks for `2 × remaining + 1`; the first page therefore requests five native slots. */
export const REQUESTED_SIZE = 2 * PAGE_SLOTS + 1;
export const SCALES = [64, 512, 4096] as const;
export const COMPOSED_READS = 16;
export const COMPOSED_SLOTS = 128;
export const COMPOSED_SLOT_EACH = COMPOSED_SLOTS / COMPOSED_READS;
export const MAX_FILTER_LEAVES = 32;
export const MAX_REFILL_ROUNDS = 3;
export const DIRECT_ENGINE_SEARCHES = 6;
export const READY_INDEX_READS = 2;
export const DIRECT_OWNER_SEEKS = 3;
export const PREPARATION_INPUT = 1000;
export const PREPARATION_RESULT_WRITES = 1000;
export const PREPARATION_FRONTIER_WRITES = 1;
export const PREPARATION_ENGINE_SEARCHES = 4;
export const PREPARATION_STATEMENTS = 16;
export const ONE_READ_STATEMENTS = 12;
export const KIB = 1024;
export const MIB = 1024 * 1024;

export const costKeys = [
  'inputKeys',
  'candidates',
  'accessPoints',
  'dependencyPoints',
  'engineSearches',
  'engineIteratorSteps',
  'outputSlots',
  'resultWrites',
  'frontierWrites',
] as const satisfies readonly (keyof PublicFilterCost)[];

export type PlanKind = 'direct' | 'ready';
export type SnapshotKind = 'pit' | 'prepared';

export type ReadBound = Readonly<{
  kind: PlanKind;
  slots: number;
  candidates: number;
  engineSearches: number;
  ownerSeeks: number;
  accessDependencyPoints: (candidates: number) => number;
  examinedRows: (candidates: number) => number;
  sharedBlocks: (examinedRows: number) => number;
  requestBytes: (candidates: number) => number;
  responseBytes: (candidates: number) => number;
  statements: number;
  connections: 1;
}>;

export type ComposedPageBound = Readonly<{
  reads: number;
  slots: number;
  candidates: number;
  discardedCandidates: number;
  rereads: number;
  accessDependencyPoints: number;
  examinedRows: number;
  statements: number;
  engineSearches: number;
  connections: 1;
  privacyStatements: 2;
  privacyExaminedRows: (behindOrChangedHomes: number) => number;
  preparationInputKeys: number;
  preparationResultWrites: number;
  nestedEngineSearches: number;
}>;

export type PreparationStepBound = Readonly<{
  inputKeys: number;
  resultWrites: number;
  frontierWrites: number;
  accessDependencyPoints: (inputKeys: number) => number;
  examinedRows: (inputKeys: number) => number;
  statements: number;
  engineSearches: number;
  connections: 1;
  responseBytes: number;
}>;

/** Nested Access/engine/preparation work, discarded candidates and the one-step reread ceiling. */
export type NestedProducerBound = Readonly<{
  discardedCandidates: number;
  rereads: number;
  accessDependencyPoints: number;
  engineSearches: number;
  preparationInputKeys: number;
  preparationResultWrites: number;
  preparationExaminedRows: number;
}>;

export function zeroCost(): PublicFilterCost {
  return {
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
}

export function sumCosts(costs: readonly PublicFilterCost[]): PublicFilterCost {
  const total = { ...zeroCost() };
  for (const cost of costs) for (const key of costKeys) total[key] += cost[key];
  return total;
}

export function snapshotKind(kind: PlanKind): SnapshotKind {
  return kind === 'direct' ? 'pit' : 'prepared';
}

export function planKind(snapshot: SnapshotKind): PlanKind {
  return snapshot === 'pit' ? 'direct' : 'ready';
}

/** Direct catalogue/owner index: `min(600, 6s + 3)` actual candidates including rejects and lookahead. */
export function directCandidateCeiling(slots: number): number {
  return Math.min(600, 6 * slots + 3);
}

/** Ready-result page: already-filtered rows plus disclosure rejects and one lookahead. */
export function readyCandidateCeiling(slots: number): number {
  return 2 * slots + 2;
}

export function candidateCeiling(kind: PlanKind, slots: number): number {
  return kind === 'direct' ? directCandidateCeiling(slots) : readyCandidateCeiling(slots);
}

export function engineSearchCeiling(kind: PlanKind): number {
  return kind === 'direct' ? DIRECT_ENGINE_SEARCHES : READY_INDEX_READS;
}

export function accessDependencyCeiling(candidates: number): number {
  return 16 + 8 * candidates;
}

export function examinedRowCeiling(candidates: number): number {
  return 64 + 16 * candidates;
}

export function sharedBlockCeiling(examinedRows: number): number {
  return 6 * examinedRows;
}

export function requestByteCeiling(candidates: number): number {
  return 64 * KIB + 1 * KIB * candidates;
}

export function responseByteCeiling(candidates: number): number {
  return 16 * KIB + 4 * KIB * candidates;
}

export function composedStatementCeiling(reads: number): number {
  return 8 + 4 * reads;
}

export function privacyExaminedRowCeiling(behindOrChangedHomes: number): number {
  return 64 + 2 * behindOrChangedHomes;
}

export function deriveReadBound(kind: PlanKind, slots: number): ReadBound {
  const candidates = candidateCeiling(kind, slots);
  return {
    kind,
    slots,
    candidates,
    engineSearches: engineSearchCeiling(kind),
    ownerSeeks: kind === 'direct' ? DIRECT_OWNER_SEEKS : READY_INDEX_READS,
    accessDependencyPoints: accessDependencyCeiling,
    examinedRows: examinedRowCeiling,
    sharedBlocks: sharedBlockCeiling,
    requestBytes: requestByteCeiling,
    responseBytes: responseByteCeiling,
    statements: ONE_READ_STATEMENTS,
    connections: 1,
  };
}

/**
 * Sum per-read direct/ready ceilings before any repair. Shared per-page work (epoch, safety,
 * one disclosure batch, summaries) is inside the composed statement ceiling, not subtracted.
 */
export function deriveComposedPageBound(
  reads: readonly Readonly<{ kind: PlanKind; slots: number }>[],
): ComposedPageBound {
  if (reads.length > COMPOSED_READS) throw new RangeError(`A common page admits at most ${COMPOSED_READS} reads`);
  const slots = reads.reduce((sum, read) => sum + read.slots, 0);
  if (slots > COMPOSED_SLOTS) throw new RangeError(`A common page admits at most ${COMPOSED_SLOTS} slots`);
  let candidates = 0;
  let accessDependencyPoints = 0;
  let examinedRows = 0;
  let engineSearches = 0;
  for (const read of reads) {
    const bound = deriveReadBound(read.kind, read.slots);
    candidates += bound.candidates;
    accessDependencyPoints += bound.accessDependencyPoints(bound.candidates);
    examinedRows += bound.examinedRows(bound.candidates);
    engineSearches += bound.engineSearches;
  }
  return {
    reads: reads.length,
    slots,
    candidates,
    discardedCandidates: candidates,
    rereads: reads.length,
    accessDependencyPoints,
    examinedRows,
    statements: composedStatementCeiling(reads.length),
    engineSearches,
    connections: 1,
    privacyStatements: 2,
    privacyExaminedRows: privacyExaminedRowCeiling,
    preparationInputKeys: reads.length * PREPARATION_INPUT,
    preparationResultWrites: reads.length * PREPARATION_RESULT_WRITES,
    nestedEngineSearches: engineSearches + reads.length * PREPARATION_ENGINE_SEARCHES,
  };
}

/** Sixteen all-direct reads of eight slots: the published composed-page table. */
export function deriveComposedLimitBound(): ComposedPageBound {
  return deriveComposedPageBound(
    Array.from({ length: COMPOSED_READS }, () => ({ kind: 'direct' as const, slots: COMPOSED_SLOT_EACH })),
  );
}

export function derivePreparationStepBound(): PreparationStepBound {
  return {
    inputKeys: PREPARATION_INPUT,
    resultWrites: PREPARATION_RESULT_WRITES,
    frontierWrites: PREPARATION_FRONTIER_WRITES,
    accessDependencyPoints: (inputKeys) => 8 * inputKeys,
    examinedRows: (inputKeys) => 64 + 16 * inputKeys,
    statements: PREPARATION_STATEMENTS,
    engineSearches: PREPARATION_ENGINE_SEARCHES,
    connections: 1,
    responseBytes: 4 * MIB,
  };
}

export function deriveNestedProducerBound(kind: PlanKind, slots: number, preparationSteps = 0): NestedProducerBound {
  const bound = deriveReadBound(kind, slots);
  return {
    discardedCandidates: bound.candidates,
    rereads: 1,
    accessDependencyPoints: bound.accessDependencyPoints(bound.candidates),
    engineSearches: bound.engineSearches + preparationSteps * PREPARATION_ENGINE_SEARCHES,
    preparationInputKeys: preparationSteps * PREPARATION_INPUT,
    preparationResultWrites: preparationSteps * PREPARATION_RESULT_WRITES,
    preparationExaminedRows: preparationSteps * examinedRowCeiling(PREPARATION_INPUT),
  };
}

export const composedLimitBound = deriveComposedLimitBound();
export const ordinaryDirectBound = deriveReadBound('direct', PAGE_SLOTS);
export const ordinaryReadyBound = deriveReadBound('ready', PAGE_SLOTS);
export const preparationStepBound = derivePreparationStepBound();
export const ordinaryNestedBound = deriveNestedProducerBound('direct', PAGE_SLOTS);
export const ordinaryReadyNestedBound = deriveNestedProducerBound('ready', PAGE_SLOTS);

export function expectCost(cost: PublicFilterCost) {
  for (const count of Object.values(cost)) expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
}

export function expectPreparationStep(cost: PublicFilterCost) {
  expectCost(cost);
  expect(cost.inputKeys).toBeLessThanOrEqual(preparationStepBound.inputKeys);
  expect(cost.resultWrites).toBeLessThanOrEqual(preparationStepBound.resultWrites);
  expect(cost.frontierWrites).toBeLessThanOrEqual(preparationStepBound.frontierWrites);
  expect(cost.accessPoints + cost.dependencyPoints).toBeLessThanOrEqual(
    preparationStepBound.accessDependencyPoints(cost.inputKeys),
  );
  expect(cost.engineSearches).toBeLessThanOrEqual(preparationStepBound.engineSearches);
}

export type PlanEvidence = Readonly<{
  ids: readonly string[];
  examined: number;
  exhausted: boolean;
  pageCost: PublicFilterCost;
  preparationCost: PublicFilterCost;
  preparationSteps: number;
  snapshot: SnapshotKind;
  rejectedCandidates: number;
  rereads: number;
}>;

export function expectNestedProducerBudget(evidence: PlanEvidence, size = PAGE_SLOTS) {
  const nested = deriveNestedProducerBound(planKind(evidence.snapshot), size, evidence.preparationSteps);
  expect(evidence.rejectedCandidates).toBeLessThanOrEqual(nested.discardedCandidates);
  expect(evidence.rereads).toBeLessThanOrEqual(nested.rereads);
  expect(evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints).toBeLessThanOrEqual(
    nested.accessDependencyPoints,
  );
  expect(evidence.pageCost.engineSearches + evidence.preparationCost.engineSearches).toBeLessThanOrEqual(
    nested.engineSearches,
  );
  expect(evidence.preparationCost.inputKeys).toBeLessThanOrEqual(nested.preparationInputKeys);
  expect(evidence.preparationCost.resultWrites).toBeLessThanOrEqual(nested.preparationResultWrites);
}

export function expectPageBudget(evidence: PlanEvidence, size: number, outputSize: number) {
  expectCost(evidence.pageCost);
  const kind = planKind(evidence.snapshot);
  const bound = deriveReadBound(kind, size);
  const candidates = evidence.pageCost.candidates;
  expect(candidates).toBeGreaterThan(0);
  expect(candidates).toBeLessThanOrEqual(bound.candidates);
  if (kind === 'direct') {
    expect(evidence.pageCost.engineSearches).toBeGreaterThan(0);
    expect(evidence.pageCost.engineIteratorSteps).toBeGreaterThan(0);
  }
  expect(evidence.pageCost.engineSearches).toBeLessThanOrEqual(bound.engineSearches);
  expect(evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints).toBeLessThanOrEqual(
    bound.accessDependencyPoints(candidates),
  );
  expect(evidence.pageCost.outputSlots).toBeLessThanOrEqual(outputSize);
  expectCost(evidence.preparationCost);
  expectNestedProducerBudget(evidence, size);
}

export function expectHarnessRows(examinedRows: number, candidates: number) {
  expect(examinedRows).toBeLessThanOrEqual(examinedRowCeiling(candidates));
}

export function expectHarnessBlocks(blocks: number, candidates: number) {
  expect(blocks).toBeLessThanOrEqual(sharedBlockCeiling(examinedRowCeiling(candidates)));
}

export function expectComposedPageBudget(
  costs: readonly PublicFilterCost[],
  bound: ComposedPageBound = composedLimitBound,
) {
  const total = sumCosts(costs);
  expectCost(total);
  expect(costs.length).toBeLessThanOrEqual(bound.reads);
  expect(total.candidates).toBeLessThanOrEqual(bound.candidates);
  expect(total.accessPoints + total.dependencyPoints).toBeLessThanOrEqual(bound.accessDependencyPoints);
  expect(total.engineSearches).toBeLessThanOrEqual(bound.engineSearches);
  expect(total.outputSlots).toBeLessThanOrEqual(bound.slots);
}

export const ordinaryCountedLimits = {
  candidates: ordinaryDirectBound.candidates,
  engineSearches: ordinaryDirectBound.engineSearches,
  outputSlots: REQUESTED_SIZE,
} as const;

export const ordinaryCountedBounds = {
  candidates: 'constant',
  accessDependencies: 'constant',
  engineSearches: 'constant',
  iteratorSteps: 'logarithmic',
  outputSlots: 'constant',
} as const;

export const growthSeriesBounds = {
  rows: 'constant',
  blocks: 'logarithmic',
  statements: 'constant',
} as const;

export const growthByteBounds = {
  requestBytes: 'constant',
  responseBytes: 'constant',
} as const;
