import { type Bound } from '@rezics/bounds';
import type { CopyOperationPlan, WorkDimensions } from './contract/index.ts';
/** The existing native receipt is eight axes; Copy proves the ninth axis is zero. */
export declare function copyWorkDimensions(bound: Bound): WorkDimensions;
/** Consume a complete command attempt before its existing preparation and transaction. */
export declare function consumeCopyCommandAttempt(plan: CopyOperationPlan): Promise<void>;
/** Bind nested SQL to the already consumed operation so its leaves do not double charge. */
export declare function bindCopyCommandOperation<T>(plan: CopyOperationPlan, dispatch: () => Promise<T>): Promise<T>;
/** Read-only roots reserve their complete two-observation operation once. */
export declare function executeCopyOperation<T>(plan: CopyOperationPlan, dispatch: () => Promise<T>): Promise<T>;
export declare function executeCopyStatement<T>(kind: string, bound: Bound, dispatch: () => Promise<T>): Promise<T>;
export declare function executeCopyStatementWork<T>(kind: string, bound: Bound, dispatch: () => Promise<T>): Promise<T>;
