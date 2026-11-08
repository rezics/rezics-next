import type { Pool, PoolClient } from 'pg';
import type { CurrentAccountEligibilityCapability, CurrentObservation, LibraryAccountSummary } from '../../library/contract/index.ts';
import type { ContributionAttribution } from '../contract/index.ts';
export declare function createLibraryAccountEligibilityAdapter(): CurrentAccountEligibilityCapability<Pick<PoolClient, 'query'>>;
export declare function observeLibraryPublicAccount(pool: Pool, id: string, deadline: number): Promise<CurrentObservation<LibraryAccountSummary | null>>;
export declare function observeLibraryAttributions(pool: Pool, ids: readonly string[], deadline: number): Promise<CurrentObservation<ReadonlyMap<string, ContributionAttribution>>>;
