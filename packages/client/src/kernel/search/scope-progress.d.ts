export type ScopeLeafPosition = Readonly<{
    leafOrdinal: number;
    phase: 'compact' | 'selection' | 'witness';
    valueOrdinal: number;
    after: string | null;
}> | null;
/** Counts in current deterministic leaf order; each entry counts that leaf's admitted values. */
export type ScopeLeafLimits = Readonly<{
    valueCounts: readonly number[];
}>;
export type ScopeLeafProgressResult = {
    ok: true;
    position: ScopeLeafPosition;
} | {
    ok: false;
    reason: 'invalid';
};
/** Raw progress only: the existing list cursor owns encryption, binding and lifetime. */
export declare function packScopeLeafProgress(position: ScopeLeafPosition, limits: ScopeLeafLimits): string;
/** Structural validation is not an actor, group, query or native-basis authorization check. */
export declare function unpackScopeLeafProgress(record: unknown, limits: ScopeLeafLimits): ScopeLeafProgressResult;
