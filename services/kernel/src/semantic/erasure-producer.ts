import { currentCommand, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import { withReadTransaction } from './read.ts';
import { SEMANTIC_ERASURE_STORES, SEMANTIC_RECEIVING_ERASURE_STORES } from './account-erasure-stores.ts';
export { SEMANTIC_RECEIVING_ERASURE_STORES } from './account-erasure-stores.ts';

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
  const result = await withReadTransaction(pool, (tx) =>
    tx.query<SemanticCopyRole>(
      `SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j
     JOIN semantic.erasure_locator l ON l.partition_no=j.partition_no AND l.store='identity_epoch_job' AND l.record_key=j.erasure_key
     WHERE j.partition_no=$1 AND j.job_id=$2 ORDER BY l.account_id,l.role LIMIT 9`,
      [partition, jobId],
    ),
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

/** Bind a Source receipt to this executor's real fence. A deferred native constraint
 * checks the same-transaction write basis after the executor appends its commit.
 */
export async function recordSemanticSourceCommit(tx: CommandTransaction, transactionId: string): Promise<void> {
  const { partition } = currentCommand(tx);
  await tx.query(
    `INSERT INTO semantic.erasure_source_commit(partition_no,transaction_id,epoch,position)
     SELECT partition_no,$2,epoch,position+1 FROM core.partition WHERE partition_no=$1 AND write_state='active'
     ON CONFLICT DO NOTHING`,
    [partition, transactionId],
  );
}

/** The owner's native row version, independent of both partition position and identity epoch. */
async function sourceVersion(tx: CommandTransaction, store: string, key: string): Promise<string | null> {
  if (![...SEMANTIC_ERASURE_STORES, ...SEMANTIC_RECEIVING_ERASURE_STORES, 'zone', 'write_basis'].includes(store))
    throw new TypeError('Unknown Semantic Source store');
  const { partition } = currentCommand(tx);
  const table =
    store === 'zone' ? 'zones.zone' : store === 'write_basis' ? 'semantic.erasure_provenance' : `semantic.${store}`;
  const keyColumn = store === 'write_basis' ? 'record_key' : 'erasure_key';
  const partitioned =
    store === 'write_basis' ||
    (store.startsWith('identity_epoch_') && !['identity_epoch_mapping', 'identity_epoch_home_gate'].includes(store));
  const home = partitioned
    ? 'partition_no=$1'
    : `${store === 'release_composite' ? 'extension_route' : 'route'} BETWEEN $1*16 AND $1*16+15`;
  return (
    (
      await tx.query<{ version: string }>(
        `SELECT xmin::text AS version FROM ${table} WHERE ${home} AND ${keyColumn}=$2`,
        [partition, key],
      )
    ).rows[0]?.version ?? null
  );
}

/** Recheck real payload and minimizer custody in the actual same-home command. Missing
 * payload is accepted only with its real native removal receipt, never by absence alone.
 */
export async function readSemanticSourceDisposition(
  tx: CommandTransaction,
  store: string,
  key: string,
): Promise<'removed' | 'retained-nonpersonal' | null> {
  // Native pending identity custody retains account/role locators. Its own existence or a
  // generic minimizer receipt must never be interpreted as terminal source closure.
  if (store === 'identity_epoch_source_consumer_custody' || store === 'identity_epoch_source_consumer_terminal')
    return null;
  const { partition } = currentCommand(tx);
  const version = await sourceVersion(tx, store, key);
  const row = (
    await tx.query<{ disposition: 'removed' | 'retained-nonpersonal'; native_xmin: string | null }>(
      `SELECT d.disposition,d.native_xmin FROM semantic.erasure_source_disposition d
     JOIN semantic.erasure_source_commit c USING(partition_no,transaction_id)
     JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active'
     WHERE d.partition_no=$1 AND d.store=$2 AND d.record_key=$3 AND d.xmin=c.xmin FOR SHARE OF d,c,p`,
      [partition, store, key],
    )
  ).rows[0];
  if (!row || row.native_xmin !== version || (row.disposition === 'removed') !== (version === null)) return null;
  if ((SEMANTIC_RECEIVING_ERASURE_STORES as readonly string[]).includes(store)) {
    // Receiving skeletons are not terminal merely because the local minimizer retained them.
    // Resolve the real accepted effect and released native gate/custody, never their JSON hints.
    const control = store === 'identity_epoch_receiving_plan' || store === 'identity_epoch_receiving_custody';
    const closed = await tx.query(
      control
        ? `SELECT 1 FROM semantic.${store} source
       JOIN semantic.identity_epoch_receiving_custody custody USING(partition_no,job_id,effect_key)
       JOIN semantic.identity_epoch_native_commit c ON c.partition_no=custody.partition_no AND c.transaction_id=custody.transaction_id
         AND c.purpose='identity-receiving-custody' AND c.xmin=custody.xmin
       JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.write_state='active' AND p.position>=c.position
       WHERE source.partition_no=$1 AND source.erasure_key=$2`
        : `SELECT 1 FROM semantic.${store} source
       JOIN semantic.identity_epoch_receiving_record r USING(partition_no,job_id,effect_key)
       JOIN semantic.identity_epoch_receiving_effect e USING(partition_no,job_id,effect_key)
       JOIN semantic.identity_epoch_native_commit c ON c.partition_no=e.partition_no AND c.transaction_id=e.transaction_id
         AND c.purpose='library-private-follow-counts' AND c.xmin=e.xmin
       JOIN semantic.identity_epoch_receiving_gate g ON g.partition_no=r.partition_no AND g.owner_id=r.owner_id
         AND g.original=r.original AND g.owner_epoch=r.owner_epoch AND g.pending_job IS NULL AND g.pending_epoch IS NULL
       JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch AND p.epoch=g.owner_epoch
         AND p.write_state='active' AND p.position>=c.position
       WHERE source.partition_no=$1 AND source.erasure_key=$2`,
      [partition, key],
    );
    if (closed.rowCount !== 1) return null;
  }
  return row.disposition;
}

/** Persist only after the owner's real minimizer has run in this same source command. */
export function recordSemanticSourceDisposition(
  tx: CommandTransaction,
  store: string,
  recordKey: string,
  disposition: 'removed' | 'retained-nonpersonal',
): void {
  const { partition } = currentCommand(tx);
  registerCommandCallback(tx, async (transactionId) => {
    const version = await sourceVersion(tx, store, recordKey);
    if ((disposition === 'removed') !== (version === null))
      throw new TypeError('Semantic Source disposition disagrees with its native payload');
    await recordSemanticSourceCommit(tx, transactionId);
    await tx.query(
      `INSERT INTO semantic.erasure_source_disposition(partition_no,store,record_key,disposition,transaction_id,native_xmin)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(partition_no,store,record_key) DO UPDATE
       SET disposition=EXCLUDED.disposition,transaction_id=EXCLUDED.transaction_id,native_xmin=EXCLUDED.native_xmin`,
      [partition, store, recordKey, disposition, transactionId, version],
    );
  });
}
