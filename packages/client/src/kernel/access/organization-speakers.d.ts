import type { Pool } from 'pg';
import type { PublicIdentity } from './account-data.ts';
import type { KeyRing } from '../tokens/seal.ts';
export type OrganizationSpeakersPage = {
    speakers: PublicIdentity[];
    next: string | null;
};
/** Public pages advance by scanned actors, so hidden identities cannot force an unbounded refill. */
export declare function readOrganizationSpeakers(pool: Pool, tokens: KeyRing, at: Date, input: {
    accountId: string;
    limit?: number;
    cursor?: string;
    viewer?: string | null;
}): Promise<OrganizationSpeakersPage>;
