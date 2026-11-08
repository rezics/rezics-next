/** Execution binding independent of account commands and shelf admission. */
import type { Bound } from '@rezics/bounds';
/** Wrap an existing Library command without changing its identity, authorization,
 * deadline, attempts, transaction, or result handling. This is a local cost
 * binding seam, not another admission or funding protocol.
 */
export type LibraryCommandExecutionPlan = Readonly<{
    operation: string;
    total: Bound;
}>;
export type LibraryCommandExecutionBinding = <T>(dispatch: () => Promise<T>, plan?: LibraryCommandExecutionPlan) => Promise<T>;
export declare function runLibraryCommand<T>(dispatch: () => Promise<T>, bind?: LibraryCommandExecutionBinding, plan?: LibraryCommandExecutionPlan): Promise<T>;
