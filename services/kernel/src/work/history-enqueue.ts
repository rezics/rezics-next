import { jsonParameter } from '../sql/json.ts';
import { beginRecordHistorySerialization, recordRecordHistoryCopy } from '../history/record-source.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { guardHistoryAccounts } from '../history/gates.ts';
import { encodeLocator, validateLocator, validateScope, type HistoryScope } from '../history/locator.ts';
import { enqueueWorkIntent, hasRetainedWorkCopies, type WorkClient, type WorkIntent } from './client.ts';
import record from '../history/record.sql';
// Separate operational provenance. Existing command and identity producers keep their own paths.
export { receiveOperationalWorkDestination as receiveOperationalHistoryWork } from '../history/operational-work-receiving.ts';

export type ScopedWorkRequest = Readonly<{ owner: string; intent: WorkIntent; scope: HistoryScope }>;
function validate(request: ScopedWorkRequest, custodyId = request.intent.workflowId) {
  validateLocator('durable-work/v1', { artifactType: 'durable-work/v1', workId: custodyId });
  // Native retired identities use UUIDs. Arbitrary SDK names and caller idempotency text are excluded.
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(custodyId) ||
    !/^[a-z][a-z0-9_.-]{0,95}$/.test(request.owner)
  )
    throw new TypeError('Invalid scoped work identity');
  validateScope('durable-work/v1', request.scope);
  const encoded = canonicalize(request);
  if (!encoded || Buffer.byteLength(encoded) > 65536) throw new TypeError('Scoped work request exceeds 64 KiB');
  return createHash('sha256').update(encoded).digest();
}

async function persist(
  tx: CommandTransaction,
  partition: number,
  source: number,
  sourceTransaction: string,
  request: ScopedWorkRequest,
  digest: Buffer,
  custodyId = request.intent.workflowId,
) {
  const result = await tx.query(
    `INSERT INTO core.history_work(partition_no,work_id,request_digest,owner,request,scope,source_partition,source_transaction)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(partition_no,work_id) DO NOTHING
     RETURNING work_id`,
    [partition, custodyId, digest, request.owner, request.intent, request.scope, source, sourceTransaction],
  );
  const found = await tx.query(
    `SELECT request_digest,owner,request,scope,source_partition,source_transaction,state,admitted
     FROM core.history_work WHERE partition_no=$1 AND work_id=$2 FOR UPDATE`,
    [partition, custodyId],
  );
  const row = found.rows[0];
  if (
    !row ||
    !Buffer.from(row.request_digest).equals(digest) ||
    row.owner !== request.owner ||
    row.source_partition !== source ||
    row.source_transaction !== sourceTransaction ||
    (row.state !== 'retired' &&
      (canonicalize(row.request) !== canonicalize(request.intent) ||
        canonicalize(row.scope) !== canonicalize(request.scope)))
  )
    throw new TypeError('Conflicting scoped work request');
  if (row.state === 'retired') return { retired: true, admitted: true };
  if (result.rows.length)
    await record.run(tx, {
      partition_no: partition,
      artifact_type: 'durable-work/v1',
      locator: Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: custodyId })),
      accounts: jsonParameter(request.scope.accounts),
    });
  return { retired: false, admitted: row.admitted as boolean };
}

/** Origin intent and exact role-union custody commit with the source command. The caller releases
 * that transaction before receiveHistoryWork checks out the DBOS destination. No SDK call occurs here. */
export async function stageHistoryWork(tx: CommandTransaction, input: ScopedWorkRequest): Promise<void> {
  beginRecordHistorySerialization(tx);
  const request = structuredClone(input);
  const digest = validate(request);
  const command = currentCommand(tx);
  await guardHistoryAccounts(tx, command.partition, request.scope.accounts);
  await persist(tx, command.partition, command.partition, command.transactionId, request, digest);
  await recordRecordHistoryCopy(tx, { artifactType: 'durable-work/v1', workId: request.intent.workflowId });
}

/** Actual legacy-named identity SDK executions use a newly persisted native custody UUID.
 * The owner must create the immutable mapping in this SAME receiver transaction first. */
export async function receiveMappedHistoryWork(
  tx: import('pg').PoolClient,
  work: WorkClient,
  custodyId: string,
  source: { partition: number; transactionId: string },
  request: ScopedWorkRequest,
): Promise<'admitted' | 'retired'> {
  const mapping = (
    await tx.query(`SELECT workflow_id FROM core.agent_identity_work WHERE custody_id=$1 FOR SHARE`, [custodyId])
  ).rows[0];
  if (mapping?.workflow_id !== request.intent.workflowId)
    throw new TypeError('Missing native identity SDK workflow mapping');
  const digest = validate(request, custodyId);
  const bound = (
    await tx.query(
      `UPDATE core.agent_identity_work SET request_digest=$2 WHERE custody_id=$1
     AND (request_digest IS NULL OR request_digest=$2) RETURNING custody_id`,
      [custodyId, digest],
    )
  ).rows[0];
  if (!bound) throw new TypeError('Conflicting native identity SDK request digest');
  const existing = (
    await tx.query(
      'SELECT state,request_digest FROM core.history_work WHERE partition_no=0 AND work_id=$1 FOR UPDATE',
      [custodyId],
    )
  ).rows[0];
  if (existing?.state === 'retired') {
    if (!Buffer.from(existing.request_digest).equals(digest)) throw new TypeError('Conflicting retired identity work');
    return 'retired';
  }
  await guardHistoryAccounts(tx, 0, request.scope.accounts);
  const stored = await persist(tx, 0, source.partition, source.transactionId, request, digest, custodyId);
  // Always re-enter the SDK's deduplicating transactional admission. Native retirement is
  // checked first even when somebody has removed SDK dedup rows. Arguments and IDs stay exact.
  if (!stored.retired) {
    const legacyCopies = !existing && (await hasRetainedWorkCopies(tx, request.intent.workflowId));
    let created: boolean | undefined;
    await enqueueWorkIntent(work, tx, request.intent, (value) => {
      created = value;
    });
    if (created === undefined) throw new TypeError('Identity SDK creation seam unavailable');
    if (created && !existing && !legacyCopies)
      await tx.query('UPDATE core.agent_identity_work SET creation_captured=true WHERE custody_id=$1', [custodyId]);
    await tx.query('UPDATE core.history_work SET admitted=true WHERE partition_no=0 AND work_id=$1', [custodyId]);
  }
  return stored.retired ? 'retired' : 'admitted';
}

/** Kernel DBOS is schema dbos in this same configured database. Partition zero is its fixed
 * receiving home. Source and receiving connections are never held together. Both crash cuts replay
 * the exact native UUID/request; the retired row survives loss of DBOS deduplication history. */
export async function receiveHistoryWork(
  pool: Pool,
  work: WorkClient,
  sourcePartition: number,
  workId: string,
): Promise<'admitted' | 'retired'> {
  const source = await withConnection(pool, async (tx) => {
    const result = await tx.query(
      `SELECT request_digest,owner,request,scope,source_transaction,state FROM core.history_work
       WHERE partition_no=$1 AND work_id=$2`,
      [sourcePartition, workId],
    );
    const row = result.rows[0];
    if (!row) throw new TypeError('Scoped work origin unavailable');
    const locator = Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId }));
    const copies = await tx.query(
      `SELECT source_key,original_transaction,original_position,producer_version FROM core.record_history_locator
       WHERE partition_no=$1 AND artifact_type='durable-work/v1' AND locator=$2 ORDER BY source_key LIMIT 17`,
      [sourcePartition, locator],
    );
    if (copies.rows.length > 16) throw new TypeError('Too many original work record sources');
    const sets = await tx.query(
      `SELECT source_partition,set_locator,set_revision,original_transaction,original_position,producer_version
       FROM core.record_history_source_set_copy
       WHERE partition_no=$1 AND artifact_type='durable-work/v1' AND locator=$2 LIMIT 2`,
      [sourcePartition, locator],
    );
    if (sets.rows.length > 1 || (sets.rows.length && copies.rows.length))
      throw new TypeError('Conflicting original work record source declarations');
    if (
      sets.rows.some(
        (set) =>
          set.original_position === null ||
          set.producer_version !== 1 ||
          set.source_partition !== sourcePartition ||
          set.original_transaction !== row.source_transaction,
      )
    )
      throw new TypeError('Uncommitted original work record source set');
    return { ...row, recordCopies: copies.rows, recordSets: sets.rows, recordLocator: locator };
  });
  if (source.state === 'retired') return 'retired';
  const request: ScopedWorkRequest = { owner: source.owner, intent: source.request, scope: source.scope };
  const digest = validate(request);
  if (!digest.equals(Buffer.from(source.request_digest))) throw new TypeError('Scoped work origin digest mismatch');
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      // Acquire the native identity first: a delayed replay of an already retired request must
      // recognize retirement even though its scope is now sealed.
      const existing = await tx.query(
        'SELECT state,request_digest FROM core.history_work WHERE partition_no=0 AND work_id=$1 FOR UPDATE',
        [workId],
      );
      if (existing.rows[0]?.state === 'retired') {
        if (!digest.equals(Buffer.from(existing.rows[0].request_digest)))
          throw new TypeError('Conflicting retired work');
        await tx.query('COMMIT');
        return 'retired';
      }
      await guardHistoryAccounts(tx, 0, request.scope.accounts);
      const stored = await persist(tx, 0, sourcePartition, source.source_transaction, request, digest);
      for (const copy of source.recordCopies)
        await tx.query(
          `INSERT INTO core.record_history_locator
           (source_key,partition_no,artifact_type,locator,original_transaction,original_position,producer_version)
           VALUES($1,0,'durable-work/v1',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [
            copy.source_key,
            source.recordLocator,
            copy.original_transaction,
            copy.original_position,
            copy.producer_version,
          ],
        );
      for (const set of source.recordSets) {
        await tx.query(
          `INSERT INTO core.record_history_source_set_copy
           (source_partition,set_locator,set_revision,partition_no,artifact_type,locator,
            original_transaction,original_position,producer_version)
           VALUES($1,$2,$3,0,'durable-work/v1',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            set.source_partition,
            set.set_locator,
            set.set_revision,
            source.recordLocator,
            set.original_transaction,
            set.original_position,
            set.producer_version,
          ],
        );
        const accepted = await tx.query(
          `SELECT source_partition,set_locator,set_revision,original_transaction,original_position,producer_version
           FROM core.record_history_source_set_copy
           WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1 FOR SHARE`,
          [source.recordLocator],
        );
        const row = accepted.rows[0];
        if (
          !row ||
          row.source_partition !== set.source_partition ||
          !Buffer.from(row.set_locator).equals(Buffer.from(set.set_locator)) ||
          !Buffer.from(row.set_revision).equals(Buffer.from(set.set_revision)) ||
          row.original_transaction !== set.original_transaction ||
          row.original_position !== set.original_position ||
          row.producer_version !== set.producer_version
        )
          throw new TypeError('Conflicting received work record source set');
      }
      if (!stored.retired && !stored.admitted) {
        await enqueueWorkIntent(work, tx, request.intent);
        await tx.query('UPDATE core.history_work SET admitted=true WHERE partition_no=0 AND work_id=$1', [workId]);
      }
      await tx.query('COMMIT');
      return stored.retired ? 'retired' : 'admitted';
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

/** Exact owning consumer handoff. Call in the transaction that completes/transfers the native
 * obligation. A terminal DBOS status or relay checkpoint never calls this port on its own. */
export async function settleHistoryWork(
  tx: CommandTransaction,
  input: { partition: number; workId: string; digest: Uint8Array; owner: string },
): Promise<void> {
  const result = await tx.query(
    `UPDATE core.history_work SET owner_ready=true,state=CASE WHEN state='retired' THEN state ELSE 'ready' END
     WHERE partition_no=$1 AND work_id=$2 AND request_digest=$3 AND owner=$4 RETURNING work_id`,
    [input.partition, input.workId, Buffer.from(input.digest), input.owner],
  );
  if (result.rows.length !== 1) throw new TypeError('Scoped work consumer handoff mismatch');
}
