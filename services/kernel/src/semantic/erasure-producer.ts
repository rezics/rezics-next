import { currentCommand, registerCommandCallback, type CommandTransaction } from '../command/command.ts';

/** Explicit account input of a native platform producer, in the producer's own home/transaction.
 * No account registry or business payload is copied. Deferred source hooks attach exact record ordinals.
 */
export async function recordSemanticProducerRole(
  tx: CommandTransaction,
  transactionId: string,
  accountId: string,
  role: 'subject' | 'operator',
): Promise<void> {
  const command = currentCommand(tx);
  await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [transactionId]);
  await tx.query(
    `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [command.partition, transactionId, accountId, role],
  );
}

export type SemanticCopyRole = { account_id: string; role: string };

/** Exact source/provenance join before opening the receiving home. */
export async function semanticCopyRoles(
  pool: import('pg').Pool,
  subjectId: string,
  candidateId: string,
): Promise<SemanticCopyRole[]> {
  const { routeOf, partitionOf } = await import('../route/route.ts');
  const route = routeOf(subjectId)!;
  const result = await pool.query<SemanticCopyRole>(
    `SELECT DISTINCT l.account_id::text,l.role
    FROM semantic.candidate c JOIN semantic.erasure_locator l
      ON l.partition_no=$1 AND l.store='candidate' AND l.record_key=c.erasure_key
    WHERE c.route=$2 AND c.subject_id=$3 AND c.candidate_id=$4`,
    [partitionOf(route), route, subjectId, candidateId],
  );
  return result.rows;
}

/** Bounded real job-home provenance, loaded before a receiving-home command is opened. */
export async function identityErasureRoles(pool: import('pg').Pool, jobId: string): Promise<SemanticCopyRole[]> {
  const { routeOf, partitionOf } = await import('../route/route.ts');
  const partition = partitionOf(routeOf(jobId)!);
  const result = await pool.query<SemanticCopyRole>(
    `SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j
     JOIN semantic.erasure_locator l ON l.partition_no=j.partition_no AND l.store='identity_epoch_job' AND l.record_key=j.erasure_key
     WHERE j.partition_no=$1 AND j.job_id=$2 ORDER BY l.account_id,l.role LIMIT 9`,
    [partition, jobId],
  );
  if (result.rows.length > 8) throw new TypeError('Identity producer role bound exceeded');
  return result.rows;
}

/** Typed provenance travels with actual admission input and commits in the receiving source transaction. */
export function bindSemanticProducerRoles(tx: CommandTransaction, roles: readonly SemanticCopyRole[]): void {
  const { partition } = currentCommand(tx);
  if (roles.length > 8) throw new TypeError('Identity producer role bound exceeded');
  registerCommandCallback(tx, async (transactionId) => {
    await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [transactionId]);
    await tx.query(
      `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
      SELECT $1,$2,account_id,role FROM unnest($3::uuid[],$4::text[]) AS input(account_id,role) ON CONFLICT DO NOTHING`,
      [partition, transactionId, roles.map((r) => r.account_id), roles.map((r) => r.role)],
    );
  });
}
