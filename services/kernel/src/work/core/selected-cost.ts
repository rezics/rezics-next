import { BOUND_AXES, declareBound, sumBounds, type Bound } from '@rezics/bounds';
import { WORK_COST_AXES, type WorkCost } from '../contract/index.ts';

export function SELECTED_AXES() {
  return BOUND_AXES;
}

export type SelectedCost = Bound;

export const selectedCost = (rows: number, points: number, statements: number, bytes: number): SelectedCost =>
  declareBound({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    witnessKeys: 0,
    statements,
    bytes,
    emptySeeks: points,
    engineRequests: 0,
  });

export function sumSelectedCost() {
  return sumBounds;
}

export function isSelectedCost(value: unknown): value is WorkCost {
  if (!value || typeof value !== 'object') return false;
  try {
    declareBound(value);
    return WORK_COST_AXES.every((axis) => axis in value);
  } catch {
    return false;
  }
}

const times = (n: number, part: SelectedCost) => sumBounds(...Array.from({ length: n }, () => part));

let cost: ReturnType<typeof buildCost> | undefined;
let cleanup: SelectedCost | undefined;
let local: SelectedCost | undefined;

function buildCost() {
  return Object.freeze({
    issue: selectedCost(8, 9, 8, 49152),
    release: selectedCost(2, 2, 2, 4096),
    consume: selectedCost(9, 9, 8, 24576),
    continuation: selectedCost(10, 12, 7, 49152),
    enqueue: selectedCost(10, 10, 9, 18432),
    hold: selectedCost(7, 7, 6, 24576),
    transaction: selectedCost(7, 3, 12, 1024),
    rollback: selectedCost(0, 0, 2, 128),
    original: selectedCost(5, 5, 5, 2097152),
    tuple: selectedCost(4, 4, 3, 6291456),
    association: selectedCost(6, 8, 5, 6291456),
    result: selectedCost(2, 4, 2, 49152),
  });
}

export function SELECTED_COST() {
  return (cost ??= buildCost());
}

export function SELECTED_CLEANUP_DECLARATION() {
  const table = SELECTED_COST();
  return (cleanup ??= sumBounds(table.release, times(3, table.rollback)));
}

export function SELECTED_LOCAL_DECLARATION() {
  const table = SELECTED_COST();
  return (local ??= sumBounds(
    table.issue,
    table.consume,
    table.enqueue,
    times(4, table.continuation),
    times(
      3,
      sumBounds(table.transaction, times(2, table.hold), table.original, times(2, table.tuple), table.association, table.result),
    ),
    SELECTED_CLEANUP_DECLARATION(),
  ));
}
