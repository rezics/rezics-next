/** Access could not finish; absence of evidence is not evidence of a denial. */
export declare class AccessUnavailableError extends Error {
    readonly reason: 'deadline' | 'overloaded' | 'contention';
    constructor(reason: 'deadline' | 'overloaded' | 'contention');
}
export declare function requireAccessDeadline(deadline: number): void;
/** Constant-time classification shared by all Access failure boundaries. */
export declare function throwAccessUnavailable(error: unknown, deadline?: number): void;
