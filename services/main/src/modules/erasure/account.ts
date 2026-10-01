import type { Pool } from 'pg';
import { eraseLibraryImportsForPrincipals } from '../library-import/privacy.ts';
import { recordAccountPreservation } from '../public-report/preservation.ts';
import { ensureRetentionDomain, markErasureSuppressed, recordErasureInventory,
  relayTransaction } from './journal.ts';

export const ACCOUNT_LIVE_DOMAIN = 'account:postgresql:live';
export const ACCOUNT_WAL_DOMAIN = 'account:postgresql-wal:live';
export const ACCOUNT_LIVE_RETENTION =
  'Account PostgreSQL keeps prior credential row versions and WAL until a qualified rewrite';

/** Five indexed Account credential probes per subject, with at most one result per subject. */
export async function accountCredentialsPresent(account: Pool,
  subjects: readonly string[]): Promise<Set<string>> {
  if (subjects.length > 1000) throw new Error('Account erasure probe exceeds its page bound');
  if (!subjects.length) return new Set();
  const rows = await account.query<{ id: string }>(`SELECT wanted.id FROM unnest($1::text[]) AS wanted(id)
    WHERE EXISTS (SELECT 1 FROM "user" WHERE id = wanted.id)
       OR EXISTS (SELECT 1 FROM "account" WHERE "userId" = wanted.id)
       OR EXISTS (SELECT 1 FROM "session" WHERE "userId" = wanted.id)
       OR EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "userId" = wanted.id)
       OR EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "userId" = wanted.id)`, [subjects]);
  return new Set(rows.rows.map(row => row.id));
}

/**
 * Settle Account erasures journaled by the subject tombstone trigger. An entry is
 * suppressed only after Account no longer has the user and any bound Access
 * principal is inactive with its retained deletion intent; the entry then links
 * that intent and records the credential copy inventory. Run from the operator
 * relay command after Account deletion intents are mirrored.
 */
export async function settleAccountErasures(relay: Pool, access: Pool, account: Pool,
  limit = 100, content?: Pool): Promise<number> {
  const pending = (await relay.query<{ id: string; account_issuer: string; account_subject: string }>(
    `SELECT id, account_issuer, account_subject FROM relay.erasure
     WHERE kind = 'account' AND stage = 'requested' ORDER BY erasure_epoch LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)])).rows;
  let settled = 0;
  for (const entry of pending) {
    await recordAccountPreservation(access, entry.account_issuer, entry.account_subject, entry.id);
    if ((await accountCredentialsPresent(account, [entry.account_subject])).size) continue;
    const principal = (await access.query<{ id: string; active: boolean }>(
      `SELECT id, active FROM access.principal WHERE account_issuer = $1 AND account_subject = $2`,
      [entry.account_issuer, entry.account_subject])).rows[0];
    if (principal?.active) continue;
    if (principal && content) await eraseLibraryImportsForPrincipals(content,access,[principal.id]);
    const linked = await relayTransaction(relay, async client => {
      if (principal) {
        const intent = await client.query(
          'SELECT 1 FROM relay.account_deletion_intent WHERE principal_id = $1', [principal.id]);
        if (!intent.rowCount) return false;
        await client.query(`UPDATE relay.erasure SET deleted_principal_id = $2
          WHERE id = $1 AND deleted_principal_id IS NULL`, [entry.id, principal.id]);
      }
      await markErasureSuppressed(client, entry.id);
      return true;
    });
    if (!linked) continue;
    await ensureRetentionDomain(relay, { label: ACCOUNT_LIVE_DOMAIN, owner: 'account',
      store: 'postgresql', custody: 'live' });
    await ensureRetentionDomain(relay, { label: ACCOUNT_WAL_DOMAIN, owner: 'account',
      store: 'postgresql_wal', custody: 'live' });
    if (content) {
      await ensureRetentionDomain(relay, { label: 'content:postgresql:live', owner: 'content',store: 'postgresql',custody: 'live' });
      await ensureRetentionDomain(relay, { label: 'content:postgresql-wal:live', owner: 'content',store: 'postgresql_wal',custody: 'live' });
    }
    await recordErasureInventory(relay, entry.id,
      { owners: content ? ['account','content'] : ['account'], liveRetentionReason: ACCOUNT_LIVE_RETENTION,
        liveRetentionReasons: { content: 'Content PostgreSQL keeps prior private upload row versions and WAL until a qualified rewrite' } });
    settled++;
  }
  return settled;
}
