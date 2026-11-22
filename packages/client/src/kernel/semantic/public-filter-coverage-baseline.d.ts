import type { Pool, PoolClient } from 'pg';
import type { AccountDiscoveryEnrollment } from '../access/account-discovery-reduction.ts';
import type { PublicFilterConsumer } from './public-filter-source-contract.ts';
import type { NativePublicSource } from './public-filter-source-binding.ts';
import type { PublicFilterDependencyKey } from './public-filter-source-contract.ts';
export type PublicFilterBaselineBinding = Readonly<{
    bootstrap: string;
    registration: Readonly<{
        partition: number;
        id: string;
    }>;
    definition: string;
    /** Original Search encoding, not a caller-provided permission or cut. */
    consumer: string;
    accounts: boolean;
}>;
/** Pin the generation BEFORE taking any native home baseline. A later ACK can
 * never renew this preparation's generation or original immutable chain.
 */
export declare function beginPublicFilterCoverageBaseline(pool: Pool, input: PublicFilterBaselineBinding, deadline: number): Promise<bigint>;
/** Adopt a verified contiguous prefix with one registration lock and commit
 * both cursor advances with the original receipt chain and per-home effects.
 */
export declare function adoptPublicFilterCoverageBaselinePage<T = void>(pool: Pool, input: PublicFilterBaselineBinding, enrollments: readonly AccountDiscoveryEnrollment[], deadline: number, readCommitted?: (client: PoolClient) => Promise<T>): Promise<T | undefined>;
/** Adopt an ordinary registration page. Recheck the committed receipts and pins
 * in a single statement transaction, releasing all home locks before adoption.
 */
export declare function adoptPublicFilterRegistrationBaselinePage(pool: Pool, input: PublicFilterBaselineBinding, enrollments: readonly AccountDiscoveryEnrollment[], deadline: number): Promise<void>;
type HomeRange = Readonly<{
    start: number;
    end: number;
}>;
export type PreparedEnrollmentRange = HomeRange & Readonly<{
    digest: string;
}>;
export type ColdEnrollmentStage = Readonly<{
    action: 'prepare' | 'prepare-and-adopt';
    ranges: readonly HomeRange[];
}> | Readonly<{
    action: 'adopt';
    ranges: readonly PreparedEnrollmentRange[];
}>;
export type ColdEnrollmentRequest = Readonly<{
    version: 1;
    job: string;
    byteLimit: number;
}> & ColdEnrollmentStage;
/** Fund all preparation and ordered adoption from the same Search offer. */
export declare function planColdSubjectEnrollment(dependencies: readonly PublicFilterDependencyKey[], frontier: number, inputLimit: number, byteLimit: number, separateAdoption?: boolean): readonly HomeRange[] | null;
type ColdEnrollmentBinding = PublicFilterBaselineBinding & Readonly<{
    originalConsumer: PublicFilterConsumer;
    sourceConsumer: string;
    source: NativePublicSource;
    generation: string;
    job: string;
    keys: readonly string[];
}>;
export declare function coldEnrollmentFunding(request: ColdEnrollmentRequest, keys: readonly string[]): {
    inputs: number;
    bytes: number;
};
export declare function readPublicFilterRegistrationReceiptPrefix(pool: Pool, binding: PublicFilterBaselineBinding & Readonly<{
    keys: readonly string[];
}>, range: HomeRange, deadline: number): Promise<AccountDiscoveryEnrollment[]>;
export declare function prepareColdEnrollment(pool: Pool, binding: ColdEnrollmentBinding, ranges: readonly HomeRange[], enroll: (range: HomeRange) => Promise<void>): Promise<{
    ranges: {
        start: number;
        end: number;
        digest: string;
    }[];
    frontier: number;
}>;
export declare function adoptColdEnrollment(pool: Pool, binding: ColdEnrollmentBinding, ranges: readonly PreparedEnrollmentRange[], deadline: number, preparedFrontier?: number): Promise<"adopted" | "pending">;
export {};
