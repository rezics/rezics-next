import type { WorkDimensions } from '../library/collection-source.ts';

/** Logical native work, including nested indexed probes. These are plan ceilings,
 * not returned rows. A failed dispatch spends the same term as a successful one. */
export const closureAxes = ['candidateKeys', 'identityMetadataRows', 'nativeRows', 'nativePoints',
  'witnessKeys', 'statements', 'bytes', 'emptySeeks'] as const satisfies readonly (keyof WorkDimensions)[];
export const closureZero = (): WorkDimensions => ({ candidateKeys: 0, identityMetadataRows: 0,
  nativeRows: 0, nativePoints: 0, witnessKeys: 0, statements: 0, bytes: 0, emptySeeks: 0 });
export function addClosureCost(...terms: readonly WorkDimensions[]): WorkDimensions {
  return Object.freeze(Object.fromEntries(closureAxes.map(axis => [axis, terms.reduce((n, term) => {
    if (!Number.isSafeInteger(term[axis]) || term[axis] < 0 || !Number.isSafeInteger(n + term[axis]))
      throw new RangeError('Invalid terminal closure work bound');
    return n + term[axis];
  }, 0)])) as unknown as WorkDimensions);
}
export function multiplyClosureCost(term: WorkDimensions, repetitions: number): WorkDimensions {
  if (!Number.isSafeInteger(repetitions) || repetitions < 0) throw new RangeError('Invalid closure repetitions');
  return addClosureCost(Object.fromEntries(closureAxes.map(axis => [axis, term[axis] * repetitions])) as unknown as WorkDimensions);
}
const cost = (metadata: number, rows: number, points: number, statements: number, bytes: number,
  empty: number, candidates = 0, witnesses = 0): WorkDimensions => Object.freeze({
  candidateKeys: candidates, identityMetadataRows: metadata, nativeRows: rows, nativePoints: points,
  witnessKeys: witnesses, statements, bytes, emptySeeks: empty,
});
/** BEGIN, two settings, time point, partition point, callback native receipt,
 * native event fence, finalization and both terminal controls (including rollback).
 * Domain authorization/receipt/history children are additive, never included as zero. */
export const closureFrameworkCost = cost(4, 16, 12, 14, 4096, 5);
export const closureCosts = Object.freeze({
  owner: cost(1, 1, 1, 1, 256, 1),
  source: cost(5, 8, 8, 5, 2048, 5),
  hold: cost(8, 18, 15, 10, 4096, 8),
  register: cost(8, 24, 18, 12, 6144, 10, 1, 1),
  install: cost(8, 24, 18, 12, 6144, 10, 1, 1),
  promote: cost(7, 16, 12, 8, 4096, 7, 1, 1),
  acknowledge: cost(8, 20, 16, 12, 6144, 8, 1, 1),
  release: cost(4, 10, 8, 6, 2048, 5),
  close: cost(6, 14, 10, 8, 4096, 6, 0, 1),
  withdraw: cost(8, 22, 16, 12, 6144, 8, 1, 1),
  disposition: cost(5, 12, 9, 7, 4096, 5, 1, 1),
  seal: cost(5, 12, 10, 8, 4096, 6, 0, 1),
  permit: cost(5, 14, 12, 9, 4096, 6, 1, 1),
  capture: cost(6, 16, 12, 10, 4096, 6, 1, 1),
  allocation: cost(5, 12, 9, 7, 2048, 5),
  admission: cost(5, 14, 10, 9, 4096, 6),
  debit: cost(2, 6, 4, 6, 2048, 2),
  cleanup: cost(5, 14, 12, 9, 4096, 6),
  page: (p: number) => {
    if (!Number.isInteger(p) || p < 0 || p > 100) throw new RangeError('Closure page exceeds 100');
    return cost(2 + p, 4 + p, 3 + p, 3, 1024 + p * 1024, 2 + p, p);
  },
});
export type ClosureDispatch = Exclude<keyof typeof closureCosts, 'page'>;
export function closureCommandCost(branch: ClosureDispatch): WorkDimensions {
  return addClosureCost(closureFrameworkCost, closureCosts[branch]);
}
/** One full admitted group, including 41 drain pages, every source disposition,
 * seven enrollment phases per member, retirement, failed-attempt liability and
 * accounting controls. Depth is bounded by the existing 4096-member group cap;
 * a cycle never spends another original's balance to manufacture a terminal. */
export function closureOperationCost(members: number): WorkDimensions {
  if (!Number.isInteger(members) || members < 1 || members > 4096) throw new RangeError('Invalid closure group size');
  const enrollment = addClosureCost(...(['hold', 'register', 'install', 'promote', 'acknowledge', 'release', 'cleanup'] as const)
    .map(closureCommandCost));
  const drain = addClosureCost(closureCommandCost('withdraw'), closureCommandCost('disposition'));
  const member = addClosureCost(enrollment, drain, multiplyClosureCost(closureCosts.debit, 9));
  return addClosureCost(closureCosts.admission, multiplyClosureCost(member, members),
    multiplyClosureCost(addClosureCost(closureCommandCost('close'), closureCosts.page(100)), Math.ceil(members / 100)),
    closureCommandCost('seal'), closureCommandCost('permit'));
}
