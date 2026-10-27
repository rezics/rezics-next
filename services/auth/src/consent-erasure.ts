import type { Pool } from 'pg';

export const CONSENT_ERASURE_BATCH = 100;

function admittedBatch(batch: number) {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000) throw new RangeError('Invalid consent erasure batch');
  return batch;
}

/** Remove one indexed batch of consent left by accounts erased in Auth. */
export async function eraseDueConsents(database: Pool, batch = CONSENT_ERASURE_BATCH): Promise<number> {
  const connection = await database.connect();
  let begun = false;
  try {
    await connection.query('BEGIN');
    begun = true;
    const due = await connection.query<{ account_id: string }>(
      `SELECT account_id FROM auth_consent_erasure
       WHERE due_at<=statement_timestamp()
       ORDER BY due_at,account_id
       LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [admittedBatch(batch)],
    );
    let processed = 0;
    for (const { account_id: accountId } of due.rows) {
      const owner = await connection.query('SELECT id FROM "user" WHERE id=$1', [accountId]);
      if (owner.rowCount) {
        // A stale schedule can never authorize deletion of a live account's consent.
        await connection.query('DELETE FROM auth_consent_erasure WHERE account_id=$1', [accountId]);
        processed++;
        continue;
      }

      const clients = await connection.query<{ client_id: string }>(
        'SELECT client_id FROM auth_consent WHERE account_id=$1 ORDER BY client_id',
        [accountId],
      );
      for (const { client_id: clientId } of clients.rows) {
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`auth-client:${clientId}`]);
        await connection.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [accountId, clientId]);
      }
      await connection.query(
        `DELETE FROM auth_consent_erasure e WHERE e.account_id=$1
         AND NOT EXISTS (SELECT 1 FROM auth_consent c WHERE c.account_id=e.account_id)`,
        [accountId],
      );
      processed++;
    }
    await connection.query('COMMIT');
    begun = false;
    return processed;
  } catch (error) {
    if (begun) await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

/** A cheap indexed gate keeps empty ticks out of DBOS history. */
export async function hasDueConsentErasure(database: Pool): Promise<boolean> {
  const result = await database.query<{ due: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM auth_consent_erasure WHERE due_at<=statement_timestamp()) AS due',
  );
  return result.rows[0]!.due;
}
