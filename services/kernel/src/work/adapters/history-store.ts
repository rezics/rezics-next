import canonicalize from 'canonicalize';
import { jsonParameter } from '../../database/json.ts';
import { withConnection } from '../../database/pool.ts';
import { currentCommand, currentCommandResources, type CommandTransaction } from '../../command/command.ts';
import { beginRecordHistorySerialization, recordRecordHistoryCopy } from '../../history/record-source.ts';
import { guardHistoryAccounts } from '../../history/gates.ts';
import { encodeLocator, validateLocator, validateScope, type HistoryScope } from '../../history/locator.ts';
import record from '../../history/record.sql';
import type { Pool } from 'pg';
import type { HistoryAssociationPort, WorkPool, WorkQueryClient, WorkScopedRequest } from '../contract/index.ts';

function asTx(tx: WorkQueryClient): CommandTransaction {
  return tx as CommandTransaction;
}

function asPool(pool: WorkPool): Pool {
  return pool as Pool;
}

async function persist(
  tx: CommandTransaction,
  partition: number,
  source: number,
  sourceTransaction: string,
  request: WorkScopedRequest,
  digest: Uint8Array,
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
    !Buffer.from(row.request_digest).equals(Buffer.from(digest)) ||
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

/** History association SQL and command/history primitives. Application never imports this module. */
export function createNativeHistoryAssociation(): HistoryAssociationPort {
  return {
    validateLocator(artifactType, locator) {
      validateLocator(artifactType, locator);
    },
    validateScope(artifactType, scope) {
      validateScope(artifactType, scope as HistoryScope);
    },
    encodeLocator(locator) {
      return encodeLocator(locator);
    },
    beginSerialization(tx) {
      beginRecordHistorySerialization(asTx(tx));
    },
    recordCopy(tx, locator) {
      return recordRecordHistoryCopy(asTx(tx), locator);
    },
    guardAccounts(tx, partition, accounts) {
      return guardHistoryAccounts(asTx(tx), partition, accounts);
    },
    persist(tx, partition, source, sourceTransaction, request, digest, custodyId) {
      return persist(asTx(tx), partition, source, sourceTransaction, request, digest, custodyId);
    },
    async readOrigin(pool, sourcePartition, workId) {
      return withConnection(asPool(pool), async (tx) => {
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
    },
    withConnection(pool, body) {
      return withConnection(asPool(pool), (tx) => body(tx));
    },
    beginSerializable(tx) {
      return tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE').then(() => undefined);
    },
    commit(tx) {
      return tx.query('COMMIT').then(() => undefined);
    },
    rollback(tx) {
      return tx.query('ROLLBACK').then(() => undefined);
    },
    async lockReceiving(tx, workId) {
      const existing = await tx.query<{ state: string; request_digest: Uint8Array }>(
        'SELECT state,request_digest FROM core.history_work WHERE partition_no=0 AND work_id=$1 FOR UPDATE',
        [workId],
      );
      return existing.rows[0];
    },
    async insertRecordCopies(tx, copies, locator) {
      for (const copy of copies)
        await tx.query(
          `INSERT INTO core.record_history_locator
           (source_key,partition_no,artifact_type,locator,original_transaction,original_position,producer_version)
           VALUES($1,0,'durable-work/v1',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [copy.source_key, locator, copy.original_transaction, copy.original_position, copy.producer_version],
        );
    },
    async insertRecordSets(tx, sets, locator) {
      for (const set of sets) {
        await tx.query(
          `INSERT INTO core.record_history_source_set_copy
           (source_partition,set_locator,set_revision,partition_no,artifact_type,locator,
            original_transaction,original_position,producer_version)
           VALUES($1,$2,$3,0,'durable-work/v1',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            set.source_partition,
            set.set_locator,
            set.set_revision,
            locator,
            set.original_transaction,
            set.original_position,
            set.producer_version,
          ],
        );
        const accepted = await tx.query(
          `SELECT source_partition,set_locator,set_revision,original_transaction,original_position,producer_version
           FROM core.record_history_source_set_copy
           WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1 FOR SHARE`,
          [locator],
        );
        const row = accepted.rows[0];
        if (
          !row ||
          row.source_partition !== set.source_partition ||
          !Buffer.from(row.set_locator as Uint8Array).equals(Buffer.from(set.set_locator as Uint8Array)) ||
          !Buffer.from(row.set_revision as Uint8Array).equals(Buffer.from(set.set_revision as Uint8Array)) ||
          row.original_transaction !== set.original_transaction ||
          row.original_position !== set.original_position ||
          row.producer_version !== set.producer_version
        )
          throw new TypeError('Conflicting received work record source set');
      }
    },
    markAdmitted(tx, partition, workId) {
      return tx
        .query('UPDATE core.history_work SET admitted=true WHERE partition_no=$1 AND work_id=$2', [partition, workId])
        .then(() => undefined);
    },
    async settleOwner(tx, input) {
      const result = await tx.query(
        `UPDATE core.history_work SET owner_ready=true,state=CASE WHEN state='retired' THEN state ELSE 'ready' END
         WHERE partition_no=$1 AND work_id=$2 AND request_digest=$3 AND owner=$4 RETURNING work_id`,
        [input.partition, input.workId, Buffer.from(input.digest), input.owner],
      );
      if (result.rows.length !== 1) throw new TypeError('Scoped work consumer handoff mismatch');
    },
    async readIdentityMapping(tx, custodyId) {
      const mapping = await tx.query<{ workflow_id: string }>(
        `SELECT workflow_id FROM core.agent_identity_work WHERE custody_id=$1 FOR SHARE`,
        [custodyId],
      );
      return mapping.rows[0];
    },
    async bindIdentityDigest(tx, custodyId, digest) {
      const bound = await tx.query(
        `UPDATE core.agent_identity_work SET request_digest=$2 WHERE custody_id=$1
         AND (request_digest IS NULL OR request_digest=$2) RETURNING custody_id`,
        [custodyId, digest],
      );
      return Boolean(bound.rows[0]);
    },
    captureIdentityCreation(tx, custodyId) {
      return tx
        .query('UPDATE core.agent_identity_work SET creation_captured=true WHERE custody_id=$1', [custodyId])
        .then(() => undefined);
    },
    currentCommand(tx) {
      return currentCommand(asTx(tx));
    },
    commandPool(tx) {
      return currentCommandResources(asTx(tx)).pool;
    },
  };
}
