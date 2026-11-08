import { AccessWorkAccounting } from '../../access/work.ts';
import type { Actor } from '../../request/access.ts';
import type { ScopeExecutionDimensions, ScopeExecutionLedger } from '../contract/index.ts';
type RealmExecutionReader = Readonly<{
    actor: Actor;
    deadline: number;
}>;
export type RealmExecutionContext = Readonly<{
    actor: Actor;
    deadline: number;
    work: AccessWorkAccounting;
}>;
/** Charge native Access reservations and receipts to the caller's existing Search root. */
export declare function withRealmDisclosureWork<T>(reader: RealmExecutionReader, scope: ScopeExecutionLedger, maximum: ScopeExecutionDimensions, run: (context: RealmExecutionContext) => Promise<T>): Promise<T>;
export {};
