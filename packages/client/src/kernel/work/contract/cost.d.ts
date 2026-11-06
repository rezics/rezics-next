/** Nine-axis selected-cost declaration. Values carry no dispatch authority. */
export declare const WORK_COST_AXES: readonly ['candidateKeys', 'nativeRows', 'identityMetadataRows', 'nativePoints', 'witnessKeys', 'statements', 'bytes', 'emptySeeks', 'engineRequests'];
export type WorkCostAxis = (typeof WORK_COST_AXES)[number];
export type WorkCost = Readonly<Record<WorkCostAxis, number>>;
