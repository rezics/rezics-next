import type { Pool } from 'pg';

/** Provisional consumer contract; the membership producer owns the cursor and page implementation. */
export type MembershipErasureCursor = string;

export async function eraseAccountMembershipsPage(
  _deps: { pool: Pool },
  _accountId: string,
  _after: MembershipErasureCursor | null,
): Promise<{ next: MembershipErasureCursor | null; found: number; pending: number }> {
  const error = new Error('Community erasure phase unavailable: membership producer has not landed');
  error.name = 'CommunityErasureProducerUnavailableError';
  throw error;
}
