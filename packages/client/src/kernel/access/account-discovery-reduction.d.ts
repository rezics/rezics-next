import type { Pool } from 'pg';
export { publicFilterCreationConsumer } from '../semantic/public-filter-creation-consumer.ts';
export type AccountDiscoveryReductionHead = Readonly<{
    partition: number;
    epoch: number;
    revision: bigint;
    claimRevision: bigint;
}>;
export type AccountDiscoveryReductionBinding = Readonly<{
    owner: 'accounts';
    heads: readonly AccountDiscoveryReductionHead[];
}>;
/** Native heads only. The registered shared Source owns the fixed full domain,
 * original immutable capture, comparison and independent physical incarnation.
 */
export declare function readAccountDiscoveryReductionBinding(pool: Pool, partitions: readonly number[], context: Readonly<{
    deadline: number;
}>): Promise<AccountDiscoveryReductionBinding>;
/** One retained original home receipt. The tuple domains deliberately stay separate. */
export type AccountDiscoveryEnrollment = AccountDiscoveryReductionHead & Readonly<{
    sourcePosition: bigint;
    creationPosition: bigint;
    enqueueRevision: bigint;
    keyDigest: string;
    receipt: string | null;
    complete: boolean;
}>;
/** Enrol one bounded page of the immutable compiler closure in its writer home.
 * Account writers and enrollment take population -> Source head -> enrollment.
 * No registration-home transaction is held across this operation. The original
 * baseline is sealed only after the complete key closure is enrolled. A partial
 * key frontier is never an admitted baseline; sealed receipts are immutable.
 */
export declare function enrollAccountDiscoveryHome(pool: Pool, input: Readonly<{
    partition: number;
    bootstrap: string;
    registration: Readonly<{
        partition: number;
        id: string;
    }>;
    readDefinition: string;
    keys: readonly string[];
    accounts: boolean;
}>, context: Readonly<{
    deadline: number;
}>): Promise<AccountDiscoveryEnrollment>;
