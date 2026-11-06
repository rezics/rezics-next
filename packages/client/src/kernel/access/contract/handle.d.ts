/** Validate new claims after case folding; never trim whitespace. */
export declare const HANDLE_CLAIM_PATTERN: RegExp;
export declare function isClaimHandle(value: unknown): value is string;
/** Existing handles remain addressable even when they cannot be newly claimed. */
export declare const HANDLE_LOOKUP_PATTERN: RegExp;
/** Additions require a reason and a reviewed change. */
export declare const RESERVED_HANDLES: readonly {
    handle: string;
    reason: 'platform' | 'role' | 'mention';
}[];
export declare function isReservedHandle(handle: string): boolean;
