import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { guardHistoryAccounts } from '../history/gates.ts';
import { encodeLocator, validateLocator, validateScope, type HistoryScope } from '../history/locator.ts';
import { enqueueWorkIntent, type WorkClient, type WorkIntent } from './client.ts';
import record from '../history/record.sql';

export type ScopedWorkRequest = Readonly<{ owner: string; intent: WorkIntent; scope: HistoryScope }>;
function validate(request: ScopedWorkRequest) {
  validateLocator('durable-work/v1', { artifactType: 'durable-work/v1', workId: request.intent.workflowId });
  // Native retired identities use UUIDs. Arbitrary SDK names and caller idempotency text are excluded.
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(request.intent.workflowId) ||
      !/^[a-z][a-z0-9_.-]{0,95}$/.test(request.owner)) throw new TypeError('Invalid scoped work identity');
  validateScope('durable-work/v1', request.scope);
  const encoded = canonicalize(request);
  if (!encoded || Buffer.byteLength(encoded)>65536) throw new TypeError('Scoped work request exceeds 64 KiB');
  return createHash('sha256').update(encoded).digest();
}

async function persist(tx: CommandTransaction, partition: number, source: number, sourceTransaction: string,
  request: ScopedWorkRequest, digest: Buffer) {
  const result = await tx.query(
    `INSERT INTO core.history_work(partition_no,work_id,request_digest,owner,request,scope,source_partition,source_transaction)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(partition_no,work_id) DO NOTHING
     RETURNING work_id`,
    [partition,request.intent.workflowId,digest,request.owner,request.intent,request.scope,source,sourceTransaction]);
  const found = await tx.query(
    `SELECT request_digest,owner,request,scope,source_partition,source_transaction,state,admitted
     FROM core.history_work WHERE partition_no=$1 AND work_id=$2 FOR UPDATE`, [partition,request.intent.workflowId]);
  const row = found.rows[0];
  if (!row || !Buffer.from(row.request_digest).equals(digest) || row.owner!==request.owner ||
      row.source_partition!==source || row.source_transaction!==sourceTransaction ||
      (row.state!=='retired' && (canonicalize(row.request)!==canonicalize(request.intent) ||
        canonicalize(row.scope)!==canonicalize(request.scope)))) throw new TypeError('Conflicting scoped work request');
  if (row.state==='retired') return { retired: true, admitted: true };
  if (result.rows.length) await record.run(tx, {
    partition_no: partition, artifact_type: 'durable-work/v1',
    locator: Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: request.intent.workflowId })),
    accounts: request.scope.accounts,
  });
  return { retired: false, admitted: row.admitted as boolean };
}

/** Origin intent and exact role-union custody commit with the source command. The caller releases
 * that transaction before receiveHistoryWork checks out the DBOS destination. No SDK call occurs here. */
export async function stageHistoryWork(tx: CommandTransaction, input: ScopedWorkRequest): Promise<void> {
  const request = structuredClone(input);
  const digest = validate(request);
  const command = currentCommand(tx);
  await guardHistoryAccounts(tx, command.partition, request.scope.accounts);
  await persist(tx, command.partition, command.partition, command.transactionId, request, digest);
}

/** Kernel DBOS is schema dbos in this same configured database. Partition zero is its fixed
 * receiving home. Source and receiving connections are never held together. Both crash cuts replay
 * the exact native UUID/request; the retired row survives loss of DBOS deduplication history. */
export async function receiveHistoryWork(pool: Pool, work: WorkClient, sourcePartition: number, workId: string): Promise<'admitted' | 'retired'> {
  const source = await withConnection(pool, async (tx) => {
    const result = await tx.query(
      `SELECT request_digest,owner,request,scope,source_transaction,state FROM core.history_work
       WHERE partition_no=$1 AND work_id=$2`, [sourcePartition,workId]);
    const row = result.rows[0];
    if (!row) throw new TypeError('Scoped work origin unavailable');
    return row;
  });
  if (source.state==='retired') return 'retired';
  const request: ScopedWorkRequest = { owner: source.owner, intent: source.request, scope: source.scope };
  const digest = validate(request);
  if (!digest.equals(Buffer.from(source.request_digest))) throw new TypeError('Scoped work origin digest mismatch');
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      // Acquire the native identity first: a delayed replay of an already retired request must
      // recognize retirement even though its scope is now sealed.
      const existing = await tx.query(
        'SELECT state,request_digest FROM core.history_work WHERE partition_no=0 AND work_id=$1 FOR UPDATE', [workId]);
      if (existing.rows[0]?.state==='retired') {
        if (!digest.equals(Buffer.from(existing.rows[0].request_digest))) throw new TypeError('Conflicting retired work');
        await tx.query('COMMIT');
        return 'retired';
      }
      await guardHistoryAccounts(tx,0,request.scope.accounts);
      const stored = await persist(tx,0,sourcePartition,source.source_transaction,request,digest);
      if (!stored.retired && !stored.admitted) {
        await enqueueWorkIntent(work,tx,request.intent);
        await tx.query('UPDATE core.history_work SET admitted=true WHERE partition_no=0 AND work_id=$1',[workId]);
      }
      await tx.query('COMMIT');
      return stored.retired ? 'retired' : 'admitted';
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
  });
}

/** Exact owning consumer handoff. Call in the transaction that completes/transfers the native
 * obligation. A terminal DBOS status or relay checkpoint never calls this port on its own. */
export async function settleHistoryWork(tx: CommandTransaction, input: { partition: number; workId: string; digest: Uint8Array; owner: string }): Promise<void> {
  const result = await tx.query(
    `UPDATE core.history_work SET owner_ready=true,state=CASE WHEN state='retired' THEN state ELSE 'ready' END
     WHERE partition_no=$1 AND work_id=$2 AND request_digest=$3 AND owner=$4 RETURNING work_id`,
    [input.partition,input.workId,Buffer.from(input.digest),input.owner]);
  if (result.rows.length!==1) throw new TypeError('Scoped work consumer handoff mismatch');
}
