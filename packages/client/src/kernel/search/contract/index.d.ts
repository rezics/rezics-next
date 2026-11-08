/** Search execution operands; the native bridge settles into the original caller root. */
export type ScopeExecutionDimensions = Readonly<{
    candidateKeys: number;
    nativeRows: number;
    identityMetadataRows: number;
    emptySeeks: number;
    nativePoints: number;
    witnessKeys: number;
    statements: number;
    bytes: number;
}>;
export type ScopeExecutionLedger = {
    remaining(): {
        readonly remaining: ScopeExecutionDimensions;
    };
    consume(value: ScopeExecutionDimensions): void;
};
export declare const scopeWorkAxes: readonly ['candidateKeys', 'nativeRows', 'identityMetadataRows', 'emptySeeks', 'nativePoints', 'witnessKeys', 'statements', 'bytes'];
export declare function zeroScopeWork(): ScopeExecutionDimensions;
/** Search producer vocabulary; no native implementations. */
export { membersPreparationSourcePaths } from './members-preparation.ts';
