import type { Pool } from 'pg';

/** Private display context, never authentication evidence or an operation target. */
export type AccountIdentity = { account_id: string; email: string | null };

const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The caller supplies only an account derived from the current native session.
 * Better Auth's owner name is synthetic/empty. Its nullable email is the actual
 * login/recovery address, independent of emailVerified; disclose no verification claim.
 * One user primary-key lookup, with no profile, credential or other-account read.
 */
export async function readNativeAccountIdentity(database: Pool, accountId: string): Promise<AccountIdentity> {
  // Access account IDs are canonical lowercase UUIDs; old invalid Auth rows fail unavailable.
  if (!accountIdPattern.test(accountId)) throw Object.assign(new Error('Account identity unavailable'), { status: 503 });
  const row = (
    await database.query<{ id: string; email: string | null }>('SELECT id,email FROM "user" WHERE id=$1', [accountId])
  ).rows[0];
  if (!row || row.id !== accountId) throw Object.assign(new Error('Account identity unavailable'), { status: 503 });
  const email = row.email;
  // Missing native addresses remain missing. Never derive an address from name/id.
  if (email !== null && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)))
    throw Object.assign(new Error('Account identity unavailable'), { status: 503 });
  return { account_id: accountId, email };
}
