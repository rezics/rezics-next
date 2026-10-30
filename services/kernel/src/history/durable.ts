import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { lockHistoryBarrier } from './receiving.ts';
import { sealHistoryAccount } from './gates.ts';
import type { WorkClient } from '../work/client.ts';
import { decodeLocator } from './locator.ts';
import type { HistoryBarrier, HistoryRegistry } from './registry.ts';

export const HISTORY_WORK_BOUNDS = Object.freeze({ operations: 64, eventKeys: 8, eventHistory: 64,
  payloadBytes: 65536, metadataBytes: 4096, rows: 139, bytes: 10 * 1024 * 1024 });
const TABLES = [
  { name: 'workflow_status', key: 'workflow_uuid', order: 'workflow_uuid', limit: 1, payload: ['inputs','output','error'] },
  { name: 'workflow_input', key: 'workflow_uuid', order: 'workflow_uuid', limit: 1, payload: ['inputs'] },
  { name: 'workflow_output', key: 'workflow_uuid', order: 'workflow_uuid', limit: 1, payload: ['output','error'] },
  { name: 'operation_outputs', key: 'workflow_uuid', order: 'function_id', limit: 64, payload: ['output','error'] },
  { name: 'workflow_events', key: 'workflow_uuid', order: 'key', limit: 8, payload: ['value'] },
  { name: 'workflow_events_history', key: 'workflow_uuid', order: 'function_id,key', limit: 64, payload: ['value'] },
  { name: 'notifications', key: 'destination_uuid', order: 'topic', limit: 0, payload: ['message'] },
  { name: 'streams', key: 'workflow_uuid', order: 'key,"offset"', limit: 0, payload: ['value'] },
] as const;

/** Exact supported SDK schema, including the three non-FK payload tables. Limits apply before
 * calculating row bytes, so an uncovered old execution never produces an unbounded certificate. */
async function inspect(pool: Pool, workId: string): Promise<{ empty: boolean; bounded: boolean }> {
  return withConnection(pool, async (tx) => {
    let rows = 0; let bytes = 0; let bounded = true;
    for (const table of TABLES) {
      const payloadFields = table.payload.map((field) => `'${field}'`).join(',');
      const payloadValid = table.payload.map((field) => `(value->'${field}' IS NULL OR
        jsonb_typeof(value->'${field}')='null' OR (jsonb_typeof(value->'${field}')='string'
        AND octet_length(value->>'${field}')<=65536))`).join(' AND ');
      // Only scalar lengths leave PostgreSQL. An old oversized value never becomes a new
      // private JavaScript copy just so the minimizer can reject its budget.
      const result = await tx.query<{ bytes: number; metadata_bytes: number; payload_valid: boolean }>(
        `SELECT octet_length(value::text) AS bytes,
          octet_length((value-ARRAY[${payloadFields}]::text[])::text) AS metadata_bytes,
          ${payloadValid} AS payload_valid FROM (
            SELECT to_jsonb(bounded_row) AS value FROM (
              SELECT * FROM dbos.${table.name} WHERE ${table.key}=$1 ORDER BY ${table.order} LIMIT $2
            ) bounded_row
          ) measured`, [workId,table.limit+1]);
      if (result.rows.length>table.limit) bounded=false;
      rows+=result.rows.length;
      for (const row of result.rows) {
        bytes+=row.bytes;
        if (!row.payload_valid || row.metadata_bytes>HISTORY_WORK_BOUNDS.metadataBytes) bounded=false;
      }
    }
    return { empty: rows===0, bounded: bounded && rows<=139 && bytes<10*1024*1024 };
  });
}

/** Retirement commits before any SDK call. All connections are released between native/SDK
 * phases. An absent status is never enough; a permanent retirement plus all exact probes is. */
export async function minimizeHistoryWork(
  pool: Pool, client: WorkClient,
  job: { partition_no: number; account_route: number; account_id: string }, locator: Buffer,
  registry: HistoryRegistry, barrier: HistoryBarrier,
): Promise<string | null> {
  const key=decodeLocator('durable-work/v1',locator);
  if (key.artifactType!=='durable-work/v1') throw new TypeError('Invalid durable locator');
  const prepared=await withConnection(pool,async (tx): Promise<string | null> => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      if (!await lockHistoryBarrier(tx,barrier)) throw new TypeError('History barrier mismatch');
      await sealHistoryAccount(tx,job.partition_no,job.account_route,job.account_id);
      const result=await tx.query('SELECT * FROM core.history_work WHERE partition_no=$1 AND work_id=$2 FOR UPDATE',
        [job.partition_no,key.workId]);
      const work=result.rows[0];
      let gap: string | null=null;
      if (!work) gap='work-native-custody-missing';
      else if (work.state!=='retired') {
        if (!work.owner_ready) gap='work-owner-consumer-open';
        const owner=registry.owner('durable-work/v1',work.owner);
        if (!owner) gap='work-owner-unregistered';
        if (!gap && owner) {
          const associations=await tx.query(
            `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
             WHERE partition_no=$1 AND artifact_type='durable-work/v1' AND locator=$2
             ORDER BY account_route,account_id LIMIT 65`,[job.partition_no,locator]);
          if (associations.rows.length>64 || associations.rows.some((ref)=>ref.minimizer_version!==1) ||
              !associations.rows.some((ref)=>ref.account_id===job.account_id && ref.account_route===job.account_route))
            gap='work-role-scope-unavailable';
          else {
            const readiness=await owner.readiness(tx,{ partition: job.partition_no,locator:key,
              accounts: associations.rows.map((ref)=>({accountRoute:ref.account_route,accountId:ref.account_id,roles:ref.roles})) },barrier);
            if (!readiness.ready) gap=readiness.gap;
          }
        }
        // The receiving home, not a source intent, owns actual DBOS retirement.
        if (!gap && job.partition_no!==0) {
          const destination=await tx.query('SELECT absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1',[key.workId]);
          if (!destination.rows[0]?.absence_verified) gap='work-destination-retirement-pending';
        }
        if (!gap) await tx.query(
          `UPDATE core.history_work SET state='retired',retired_at=clock_timestamp(),request=NULL,scope=NULL
           WHERE partition_no=$1 AND work_id=$2`,[job.partition_no,key.workId]);
      }
      await tx.query('COMMIT'); return gap;
    } catch (error) {await tx.query('ROLLBACK');throw error;}
  });
  if (prepared) return prepared;
  if (job.partition_no===0) {
    // A registration does not certify pre-existing history. Probe physical rows/serialized bytes.
    const before=await inspect(pool,key.workId);
    if (!before.bounded) return 'work-execution-budget-uncovered';
    await client.cancelWorkflow(key.workId,{cancelChildren:false});
    await client.deleteWorkflows([key.workId],false);
    if (!(await inspect(pool,key.workId)).empty) return 'work-physical-copy-remains';
  }
  await withConnection(pool,async (tx)=>{
    await tx.query('BEGIN');
    try {
      if (!await lockHistoryBarrier(tx,barrier)) throw new TypeError('History barrier mismatch');
      await sealHistoryAccount(tx,job.partition_no,job.account_route,job.account_id);
      await tx.query(`UPDATE core.history_work SET absence_verified=true WHERE partition_no=$1 AND work_id=$2 AND state='retired'`,
        [job.partition_no,key.workId]);
      await tx.query(
        `UPDATE core.history_locator SET state='minimized',proof_barrier=$3
         WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 AND artifact_type='durable-work/v1' AND locator=$4
           AND EXISTS(SELECT 1 FROM core.history_work w WHERE w.partition_no=$1 AND w.work_id=$5 AND w.absence_verified)`,
        [job.partition_no,job.account_route,job.account_id,locator,key.workId]);
      await tx.query('COMMIT');
    } catch(error){await tx.query('ROLLBACK');throw error;}
  });
  return null;
}
