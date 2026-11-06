/** Nine-axis selected-cost declaration. Values carry no dispatch authority. */

export const WORK_COST_AXES = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
  'engineRequests',
] as const;

export type WorkCostAxis = (typeof WORK_COST_AXES)[number];

export type WorkCost = Readonly<Record<WorkCostAxis, number>>;
