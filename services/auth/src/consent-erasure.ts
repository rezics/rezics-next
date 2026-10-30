import type { Pool } from 'pg';

export const CONSENT_ERASURE_BATCH = 1;

/** One due account/client page, including its durable completion marker. No
 * connection is retained while waiting for due time or entering another client.
 * A stale marker cannot authorize cleanup while the native user exists.
 */
export async function eraseConsentPage(database: Pool): Promise<string | null> {
  const connection = await database.connect();
  try {
    await connection.query('BEGIN');
    // Admit one raw schedule before locking. SKIP LOCKED cannot walk an arbitrary
    // locked prefix; another tick retries this exact bounded candidate.
    const due = (
      await connection.query<{ account_id: string; after_client: string }>(
        `WITH candidate AS MATERIALIZED (
         SELECT account_id FROM auth_consent_erasure WHERE due_at<=statement_timestamp()
         ORDER BY due_at,account_id LIMIT 1
       ) SELECT e.account_id,e.after_client FROM auth_consent_erasure e
       WHERE e.account_id=(SELECT account_id FROM candidate) FOR UPDATE SKIP LOCKED`,
      )
    ).rows[0];
    if (!due) {
      await connection.query('COMMIT');
      return null;
    }
    const accountId = due.account_id;
    const owner = await connection.query('SELECT id FROM "user" WHERE id=$1', [accountId]);
    if (owner.rowCount) {
      await connection.query('DELETE FROM auth_consent_erasure WHERE account_id=$1', [accountId]);
      await connection.query('COMMIT');
      return accountId;
    }
    const obligation = (
      await connection.query<{ ready: boolean }>(
        `SELECT user_deleted_at IS NOT NULL AND consent_due_at<=statement_timestamp() AS ready
       FROM auth_erasure WHERE account_id=$1`,
        [accountId],
      )
    ).rows[0];
    // A retry or a stale marker cannot shorten the original native cutoff.
    if (obligation && !obligation.ready) {
      await connection.query('COMMIT');
      return null;
    }
    const client = (
      await connection.query<{ client_id: string | null }>(
        `SELECT CASE WHEN octet_length(client_id)<=1024 THEN client_id END AS client_id FROM auth_consent WHERE account_id=$1 AND client_id>$2
       ORDER BY client_id LIMIT 1`,
        [accountId, due.after_client],
      )
    ).rows[0];
    if (client) {
      if (client.client_id === null) throw new Error('Auth consent locator exceeds 1 KiB');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `auth-client:${client.client_id}`,
      ]);
      await connection.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
        accountId,
        client.client_id,
      ]);
      await connection.query('UPDATE auth_consent_erasure SET after_client=$2 WHERE account_id=$1', [
        accountId,
        client.client_id,
      ]);
    }
    // Probe the actual native prefix, including a late/stale insertion behind
    // the boundary. New writers are fenced; historical residue is retried.
    const residue = (await connection.query('SELECT 1 FROM auth_consent WHERE account_id=$1 LIMIT 1', [accountId]))
      .rowCount;
    if (!residue) {
      await connection.query(
        `UPDATE auth_erasure SET consent_completed_at=COALESCE(consent_completed_at,clock_timestamp()),
         pending_code=CASE WHEN native_completed_at IS NOT NULL THEN 'shared-copy-custody' ELSE pending_code END,revision=revision+1 WHERE account_id=$1`,
        [accountId],
      );
      await connection.query('DELETE FROM auth_consent_erasure WHERE account_id=$1', [accountId]);
    } else if (!client) {
      await connection.query("UPDATE auth_consent_erasure SET after_client='' WHERE account_id=$1", [accountId]);
    }
    await connection.query('COMMIT');
    return accountId;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

/** Compatibility batch: a fixed number of independent native pages, never an
 * inner walk over an account's clients. The default host requests one page. */
export async function eraseDueConsents(database: Pool, batch = CONSENT_ERASURE_BATCH): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 100) throw new RangeError('Invalid consent erasure batch');
  let pages = 0;
  for (; pages < batch; pages++) if ((await eraseConsentPage(database)) === null) break;
  return pages;
}

export async function hasDueConsentErasure(database: Pool): Promise<boolean> {
  const result = await database.query<{ due: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM auth_consent_erasure WHERE due_at<=statement_timestamp()) AS due',
  );
  return result.rows[0]!.due;
}
