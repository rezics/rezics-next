export type RateLimitFamily = 'write' | 'upload' | 'report' | 'correspondence' | 'search' | 'provider' | 'address';
export type RateLimitDeclaration = {
    readonly family: RateLimitFamily;
    /** One ordinary unit, or the validated command array's cardinality (1 to 100). */
    readonly units: 1 | 'commands';
};
/**
 * Snapshots trusted server metadata for a mounted route's detail['x-rate-limit'].
 * Read-only routes omit write-rate metadata; their owning policy uses the trusted route/action catalogue.
 */
export declare function defineRateLimit(input: RateLimitDeclaration): Readonly<RateLimitDeclaration>;
/**
 * Resolves cost after native body validation, before any spend or command effects.
 * The result is the full request cost: charge a bulk once, without adding an ordinary write unit.
 * The declaration comes exclusively from registered route hooks, never request JSON or headers.
 * This helper neither charges a budget nor proves that a request was charged.
 */
export declare function rateLimitUnits(declaration: RateLimitDeclaration, validatedBody: unknown): number;
