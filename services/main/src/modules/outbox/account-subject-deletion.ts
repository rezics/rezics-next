import type { Pool } from 'pg';

export class AccountSubjectDeletionConflict extends Error {}

interface AccessDeletedSubject {
  principal_id: string;
  account_issuer: string;
  account_subject: string;
}

/** Account's beforeDelete hook retains this before Better Auth removes credentials. */
export async function retainAccountSubjectDeletion(
  relay: Pool, issuer: string, subject: string,
): Promise<number> {
  if (!issuer || !subject) throw new AccountSubjectDeletionConflict('invalid Account deletion subject');
  const result = await relay.query(
    `INSERT INTO relay.account_subject_deletion (issuer, account_subject)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`, [issuer, subject]);
  if (result.rowCount !== 1) {
    const retained = await relay.query(
      `SELECT 1 FROM relay.account_subject_deletion
       WHERE issuer = $1 AND account_subject = $2`, [issuer, subject]);
    if (retained.rowCount !== 1) {
      throw new AccountSubjectDeletionConflict('Account deletion subject was not retained');
    }
  }
  return result.rowCount ?? 0;
}

/** Backfill only while Account, Access and relay writers are quiesced. */
export async function backfillAccountSubjectDeletions(
  account: Pool, access: Pool, relay: Pool,
): Promise<number> {
  let after: string | null = null;
  let inserted = 0;
  while (true) {
    const rows: AccessDeletedSubject[] = (await access.query<AccessDeletedSubject>(
      `SELECT o.principal_id, p.account_issuer, p.account_subject
       FROM access.outbox o JOIN access.principal p ON p.id = o.principal_id
       WHERE o.kind = 'account.deletion_fenced'
         AND ($1::uuid IS NULL OR o.principal_id > $1::uuid)
       ORDER BY o.principal_id LIMIT 1000`, [after])).rows;
    for (const row of rows) {
      const live = await account.query('SELECT 1 FROM "user" WHERE id = $1 LIMIT 1',
        [row.account_subject]);
      if (live.rowCount) {
        throw new AccountSubjectDeletionConflict('Account deletion intent still has a live user');
      }
      inserted += await retainAccountSubjectDeletion(
        relay, row.account_issuer, row.account_subject);
      after = row.principal_id;
    }
    if (rows.length < 1000) break;
  }
  return inserted;
}

/** Compare all separately retained tombstones with the promoted Account owner. */
export async function assertAccountSubjectDeletionsAbsent(
  account: Pool, relay: Pool,
): Promise<void> {
  let after: { issuer: string; account_subject: string } | undefined;
  while (true) {
    const rows = (await relay.query<{ issuer: string; account_subject: string }>(
      `SELECT issuer, account_subject FROM relay.account_subject_deletion
       WHERE ($1::text IS NULL OR (issuer, account_subject) > ($1, $2))
       ORDER BY issuer, account_subject LIMIT 1000`,
      [after?.issuer ?? null, after?.account_subject ?? null])).rows;
    if (rows.length === 0) break;
    const restored = await account.query<{ id: string }>(
      'SELECT id FROM "user" WHERE id = ANY($1::text[]) LIMIT 1',
      [rows.map(row => row.account_subject)]);
    if (restored.rowCount) {
      throw new AccountSubjectDeletionConflict('retained Account deletion subject exists in restored Account');
    }
    after = rows[rows.length - 1];
    if (rows.length < 1000) break;
  }
}
