/** Native Search outcomes. Transport status, headers and problem construction belong to HTTP. */
export type SearchOperationCode = 'invalid_request' | 'unsupported_query' | 'search_restart_required' | 'index_not_ready' | 'semantic_not_ready' | 'dependency_unavailable';
export type SearchCorrectionCode = 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
export type SearchCorrection = Readonly<{
    pointer: string;
    code: SearchCorrectionCode;
}>;
/** An admitted operation's native refusal; the route supplies its HTTP representation. */
export declare class SearchOperationError extends Error {
    readonly code: SearchOperationCode;
    readonly errors: readonly SearchCorrection[] | undefined;
    readonly extensions: Readonly<Record<string, unknown>> | undefined;
    constructor(code: SearchOperationCode, options?: Readonly<{
        errors?: readonly SearchCorrection[];
        extensions?: Readonly<Record<string, unknown>>;
    }>);
}
/** Producer families retained by executed-request recovery before publishing ready. */
export type SearchNativeRecoveryFamily = 'invalid' | 'invalid-cursor' | 'session' | 'closed' | 'denied' | 'restart' | 'index-not-ready' | 'source-not-ready' | 'unavailable' | 'ready';
export type SearchNativeCorrection = Readonly<{
    pointer: string;
    code: string;
}>;
export type SearchNativeOperandRecovery = Readonly<{
    family: SearchNativeRecoveryFamily;
    corrections?: readonly SearchNativeCorrection[];
    textDiagnostic?: unknown;
    reusableRequest: boolean;
}>;
/** Authored operand bytes that retain per-value correction instead of a payload-free restart. */
export declare const SEARCH_VISIT_OPERAND_BUDGET = 4096;
export declare function searchNativeAuthoredBytes(value: unknown): number;
/** Native recovery owns retained operands and correction disclosure, independent of HTTP status. */
export declare function recoverSearchOperands(input: Readonly<{
    family: SearchNativeRecoveryFamily;
    errors?: readonly SearchNativeCorrection[];
    extensions?: Readonly<Record<string, unknown>>;
    authoredBytes: number;
}>): SearchNativeOperandRecovery;
export declare class SearchUnavailableError extends Error {
    constructor(message?: string, options?: ErrorOptions);
}
/** A candidate cannot be populated or published from an incomplete native producer set. */
export declare class DiscoveryProducerCoverageError extends Error {
    readonly missingKinds: readonly string[];
    readonly unsupportedKinds: readonly string[];
    readonly duplicateKinds: readonly string[];
    constructor(input: {
        missingKinds: readonly string[];
        unsupportedKinds: readonly string[];
        duplicateKinds: readonly string[];
    });
}
/** A signed owner continuation was invalidated; never retry its retired cut forever. */
export declare class DiscoveryPopulationCutChangedError extends DiscoveryProducerCoverageError {
    constructor(kind: import('./discovery-api.ts').DiscoveryMetadataKind);
}
/** Owner rows changed during nested hydration; the page is not one observation. */
export declare class OwnerCurrentRestartRequired extends SearchOperationError {
    constructor();
}
