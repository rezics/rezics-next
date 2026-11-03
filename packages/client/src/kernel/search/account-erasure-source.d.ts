import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
type AccountErasureSearchResult = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'observed';
    digest: string;
}>;
export type AccountErasureSearchObservation = AccountErasureSearchResult & Readonly<{
    prefix: string;
    accountId: string;
    accountPartition: number;
    eventPosition: string;
}>;
export type AccountErasureSearchReadiness = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'ready';
}>;
type AccountErasureSearchInput = Readonly<{
    accountId: string;
    accountPartition: number;
    eventPosition: bigint;
    prefix?: string;
}>;
/** Read Search's current Account enrollment through a released Source snapshot. This is only an
 * observation: History must compare it against the Account same-home transaction below.
 */
export declare function observeAccountErasureSearch(pool: Pool, input: AccountErasureSearchInput, deadline: number): Promise<AccountErasureSearchObservation>;
/** Final same-home read. A released Source observation or Search locator is never completion by
 * itself; the exact active generations, certified populations and settled copies must still match.
 */
export declare function verifyAccountErasureSearchObservation(tx: CommandTransaction, input: AccountErasureSearchInput, observation: AccountErasureSearchObservation): Promise<AccountErasureSearchReadiness>;
export {};
