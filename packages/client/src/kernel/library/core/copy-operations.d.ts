import { type Bound } from '@rezics/bounds';
import type { CopyMutationOperation, CopyMutationOperationInput, CopyInventoryOperationInput, CopyOperationPlan, CopyOperationComponent, CopyMutationWork } from '../contract/index.ts';
export declare function maximumCopyBound(...alternatives: readonly Bound[]): Bound;
export declare function copyOperationPlan(kind: string, branch: string, input: Record<string, unknown>, components: readonly CopyOperationComponent[], branches?: Readonly<Record<string, Bound>>): CopyOperationPlan;
export declare function copyMutationPlan(operation: CopyMutationOperation, input: CopyMutationOperationInput, subject: string, work: CopyMutationWork): CopyOperationPlan;
export declare function copyAccountPlan(route: number, accountId: string, floor: Bound): CopyOperationPlan;
export declare function copyReadPlan(route: number, accountId: string, copyId: string, work: Readonly<{
    read: Bound;
    transaction: Bound;
    migration: Bound;
    partition: Bound;
    response: Bound;
}>): CopyOperationPlan;
export declare function copyPresentationPlan(route: number, accountId: string, copyId: string, subjectId: string, work: Readonly<{
    observation: Bound;
    pins: Bound;
    source: Bound;
    response: Bound;
}>): CopyOperationPlan;
export declare function copyInventoryPlan(input: CopyInventoryOperationInput, work: Readonly<{
    readonly: Bound;
    page: Bound;
    sentinel: Bound;
    migration: Bound;
    options: Bound;
    pins: Bound;
    cursor: Bound;
    responses: Bound;
    cursorBytes: number;
}>): CopyOperationPlan;
