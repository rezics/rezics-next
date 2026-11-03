import type { OperationalWorkCost } from '../history/operational-work-budget.ts';
import { OPERATIONAL_WORK_AXES } from '../history/operational-work-axes.ts';

export const SELECTED_AXES = [...OPERATIONAL_WORK_AXES, 'engineRequests'] as const;
export type SelectedCost = OperationalWorkCost & Readonly<{ engineRequests: number }>;
/** Named fields, never positional conversion from a foreign declaration. */
export const selectedCost = (rows: number, points: number, statements: number, bytes: number): SelectedCost =>
  Object.freeze({
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
export function sumSelectedCost(...parts: readonly SelectedCost[]): SelectedCost {
  if (parts.some((part) => SELECTED_AXES.some((axis) => !Number.isSafeInteger(part[axis]) || part[axis] < 0)))
    throw new TypeError('Unknown or nonfinite selected work declaration');
  const total = Object.fromEntries(SELECTED_AXES.map((axis) => [axis, parts.reduce((n, part) => n + part[axis], 0)]));
  if (SELECTED_AXES.some((axis) => !Number.isSafeInteger(total[axis])))
    throw new TypeError('Selected declaration overflow');
  return Object.freeze(total) as SelectedCost;
}
const times = (n: number, part: SelectedCost) => sumSelectedCost(...Array.from({ length: n }, () => part));
/** Literal complete LOCAL dispatch partitions. Child native SQL/Source prices are additional.
 * Full-key misses consume the same bound. No debit is undone by failure/rollback. */
export const SELECTED_COST = Object.freeze({
  // Outer select + domain/status/fence/operation/input probes + attempt upsert + native return.
  // Upsert includes PK probe/insert/conflict-update; metadata projection and input <=8192.
  issue: selectedCost(8, 9, 8, 49152),
  release: selectedCost(2, 2, 2, 4096),
  // Outer held check + five locks + UPDATE; durable bit is never reset by replacement.
  consume: selectedCost(9, 9, 8, 24576),
  // Native SDK status/input exact read + continuation insert/FK/parent result probe.
  continuation: selectedCost(10, 12, 7, 49152),
  // Pinned enqueue status INSERT/conflict UPDATE and input guard, including trigger SQL.
  enqueue: selectedCost(10, 10, 9, 18432),
  // Outer call + five locks; no independent transaction. Status/attempt return never exposes owner token.
  hold: selectedCost(7, 7, 6, 24576),
  // Existing operational time transaction, partition/account fences, controls through COMMIT.
  // Rollback is split below, before checkout, to keep cleanup disjoint from usable work.
  transaction: selectedCost(7, 3, 12, 1024),
  rollback: selectedCost(0, 0, 2, 128),
  // Original + episode association + partition/domain/head; bounded original/argument encoding.
  original: selectedCost(5, 5, 5, 2097152),
  // Qualified catalog lookup, actual Collection SHARE + native episode UPDATE, no scan.
  tuple: selectedCost(4, 4, 3, 6291456),
  // Once-only row insert/conflict probe, original FK, PK/index work, readback, JSON encoding.
  association: selectedCost(6, 8, 5, 6291456),
  // Conditional pending->result UPDATE, exact result read/reconciliation, bounded JSON input/output.
  result: selectedCost(2, 4, 2, 49152),
});
export const SELECTED_CLEANUP_DECLARATION = sumSelectedCost(SELECTED_COST.release, times(3, SELECTED_COST.rollback));
/** One select, one apply and at most one reached failure; no transaction or SDK retry refills it. */
export const SELECTED_LOCAL_DECLARATION = sumSelectedCost(
  SELECTED_COST.issue,
  SELECTED_COST.consume,
  SELECTED_COST.enqueue,
  times(4, SELECTED_COST.continuation),
  times(
    3,
    sumSelectedCost(
      SELECTED_COST.transaction,
      times(2, SELECTED_COST.hold),
      SELECTED_COST.original,
      times(2, SELECTED_COST.tuple),
      SELECTED_COST.association,
      SELECTED_COST.result,
    ),
  ),
  SELECTED_CLEANUP_DECLARATION,
);
