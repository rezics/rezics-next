import type { ReleaseViolation } from '@rezics/definitions';
/** Definition publication and extension commands share the same error identities. */
export declare class DefinitionInputError extends Error {
    readonly violations: ReleaseViolation[];
    constructor(violations: ReleaseViolation[]);
}
export declare class DefinitionAccessDeniedError extends Error {
}
export declare class DefinitionNotFoundError extends Error {
}
export declare class StaleEditorialHeadError extends Error {
}
