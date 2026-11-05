import type { AccessWorkAccounting } from '../access/work.ts';
import type { WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
/** Accounting-only request context, kept free of runtime SQL dependencies. */
export type CommandWorkReservation = Readonly<{
    settle(actual?: Partial<WorkDimensions>): void;
}>;
export type CommandWorkAssociation = Readonly<{
    deadline: number;
    access: AccessWorkAccounting;
    reserve(operation: string, bound: WorkDimensions | undefined): CommandWorkReservation;
    run<T>(operation: string, bound: WorkDimensions | undefined, dispatch: () => Promise<T>, actual?: (value: T) => Partial<WorkDimensions> | undefined): Promise<T>;
    receipt(): WorkReceipt;
    /** Settle the one up-front Source reservation after the enclosing request ends. */
    close(): Error | undefined;
}>;
export declare function registerCommandWorkAssociation(association: CommandWorkAssociation): void;
/** Keep the one frame across every executor retry while leaving ordinary calls untouched. */
export declare function withCommandWorkAssociation<T>(association: CommandWorkAssociation, body: () => Promise<T>): Promise<T>;
export declare function withCommandWorkAssociation<T>(association: CommandWorkAssociation, body: () => T): T;
/** Executor-only lookup. An association is accounting context, never authority. */
export declare function currentCommandWorkAssociation(): CommandWorkAssociation | undefined;
