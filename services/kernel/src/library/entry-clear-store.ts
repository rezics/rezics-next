import type { PoolClient } from 'pg';

/** The admitted clear owns this transaction, its owner sequence, physical deletion and native receipt. */
export async function retainEntryClear(
  client: Pick<PoolClient, 'query'>,
  input: { route: number; accountId: string; subjectId: string; sequence: bigint; transactionId: string },
): Promise<void> {
  if (input.sequence <= 0n) throw new TypeError('Invalid entry clear sequence');
  const result = await client.query(
    `INSERT INTO library.entry_clear(route,account_id,subject_id,owner_write_seq,transaction_id)
     VALUES($1,$2,$3,$4::bigint,$5)
     ON CONFLICT(route,account_id,subject_id) DO UPDATE
       SET owner_write_seq=EXCLUDED.owner_write_seq,transaction_id=EXCLUDED.transaction_id
       WHERE library.entry_clear.owner_write_seq<EXCLUDED.owner_write_seq
     RETURNING subject_id`,
    [input.route, input.accountId, input.subjectId, input.sequence.toString(), input.transactionId],
  );
  if (result.rowCount !== 1) throw new Error('Entry clear must advance owner write order');
}
