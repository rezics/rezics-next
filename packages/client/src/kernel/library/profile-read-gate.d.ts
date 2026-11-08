import type { PoolClient } from 'pg';
/** Read-only rollout boundary. Existing fixed-contract DTOs can expose an unpinned
 * historical fact only before that owner's live-fact cutover. A missing job never
 * prevents reading a current pinned fact, and reads never create owner metadata.
 */
export declare function assertPreProfileLibraryRead(client: Pick<PoolClient, 'query'>, accountId: string): Promise<void>;
