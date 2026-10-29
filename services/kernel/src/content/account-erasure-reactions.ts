import type { Pool } from 'pg';

export type ReactionErasureCursor = Readonly<{ phase: 'reactions' | 'reports'; after: string | null }>;
export async function eraseAccountReactionsPage(
  _deps: { pool: Pool },
  _accountId: string,
  _cursor: ReactionErasureCursor | null,
): Promise<{ next: ReactionErasureCursor | null; found: number }> {
  return { next: null, found: 0 };
}
