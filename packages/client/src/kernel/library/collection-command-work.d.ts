/** Mechanical Library execution plumbing. No command, authorization or shelf implementations. */
import type { Bound } from '@rezics/bounds';
/** Bind a closed Library SQL declaration to the caller's existing accounting frame. */
export declare function runLibraryBoundedStep<T>(operation: string, bound: Bound, dispatch: () => Promise<T>): Promise<T>;
/** Reserve one complete Library operation, then run its leaves on the same caller-owned resources. */
export declare function runLibraryBoundedOperation<T>(operation: string, bound: Bound, dispatch: () => Promise<T>): Promise<T>;
/** Shared deadline policy for native Library work steps outside actor commands. */
export declare function workStepDeadline(): number;
export declare class LibraryNotFoundError extends Error {
    constructor();
}
/** Return the route encoded by an ID, mapping invalid IDs to the library not-found result. */
export declare function requireRoute(id: string): number;
/** Keep an ID on its owning account route and conceal foreign or malformed IDs. */
export declare function sameAccountRoute(accountId: string, id: string): number;
