import { encodeWithReferences } from './public-filter-codec.ts';
import type { RetainedRepairPage, RetainedSourceRepair } from './public-filter-custody-contract.ts';

export function encodeRepairIntent(intent: RetainedRepairPage): string {
  return encodeWithReferences(
    intent,
    intent.repairs.map((repair) => repair.projection),
  );
}

export function encodeStagedRepairWork(work: {
  repair: RetainedSourceRepair | null;
  repairPage: Pick<RetainedRepairPage, 'repairs'> | null;
}): string {
  const projections = work.repairPage?.repairs.map((repair) => repair.projection) ?? [];
  if (work.repair) projections.push(work.repair.projection);
  return encodeWithReferences(work, projections, 'value');
}
