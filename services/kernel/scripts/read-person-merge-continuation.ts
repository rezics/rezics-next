/** One read-only observation of the original reviewed operation while the walk still owns its store. */
import { Client, type Pool } from 'pg';
import { partitionOf, routeOf } from '../src/route/contract.ts';
import { IDENTITY_EPOCH_ADMITTED } from '../src/semantic/events.ts';

export async function readPersonMergeContinuation(client: Pick<Pool, 'query'> | Client, operation: string) {
  const route = routeOf(operation);
  if (route === null) return { state: 'invalid-operation' };
  const { rows } = await client.query(
    `SELECT j.state AS job, j.prearm_phase AS prearm, a.state AS admission,
       c.position AS admission_position, cp.position AS effects_checkpoint,
       o.event_seq IS NOT NULL AS admitted_event, h.state AS consumer, fx.status AS effect_workflow, fx.queue_name AS effect_queue,
       fx.started_at_epoch_ms - fx.created_at AS effect_wait_ms, w.status AS coordinator,
       output.function_name AS coordinator_step, output.error::jsonb->'json'->>'code' AS coordinator_step_error,
       m.unit AS mapping_unit, m.frontier->'after'->>1 AS mapping_phase,
       COALESCE((SELECT d.target=(j.intent->>'survivor')::uuid FROM semantic.redirect d
         WHERE d.route=((get_byte(uuid_send((j.intent->>'redirected')::uuid),10)<<8)
           + get_byte(uuid_send((j.intent->>'redirected')::uuid),11)) AND d.subject_id=(j.intent->>'redirected')::uuid
         ORDER BY d.sequence DESC LIMIT 1),false) AS redirected,
       (SELECT jsonb_object_agg(ack.step,ack.progress->>'state') FROM semantic.identity_epoch_ack ack
         WHERE (ack.partition_no,ack.job_id)=(j.partition_no,j.job_id)) AS acknowledgements
     FROM semantic.identity_epoch_job j
     LEFT JOIN semantic.identity_epoch_admission_attempt a USING(partition_no,job_id)
     LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id)
       AND c.purpose='admission'
     LEFT JOIN core.outbox o ON (o.partition_no,o.position,o.epoch)=(c.partition_no,c.position,c.epoch)
       AND o.type=$3 AND o.data->>'jobId'=j.job_id::text
     LEFT JOIN core.consumer_checkpoint cp ON cp.partition_no=j.partition_no AND cp.consumer='effects'
     LEFT JOIN core.history_event_consumer h ON (h.partition_no,h.position,h.event_seq)=(o.partition_no,o.position,o.event_seq)
       AND h.consumer='identity_epoch_admission'
     LEFT JOIN dbos.workflow_status fx ON fx.workflow_uuid=h.workflow_id
     LEFT JOIN dbos.workflow_status w ON w.workflow_uuid='semantic:identity:' || j.job_id::text || ':' || j.epoch::text
     LEFT JOIN LATERAL (
       SELECT function_name,error FROM dbos.operation_outputs WHERE workflow_uuid=w.workflow_uuid
       ORDER BY function_id DESC LIMIT 1
     ) output ON true
     LEFT JOIN semantic.identity_epoch_mapping_head m ON (m.partition_no,m.job_id)=(j.partition_no,j.job_id)
     WHERE j.partition_no=$1 AND j.job_id=$2 AND j.intent->>'kind'='merge'`,
    [partitionOf(route), operation, IDENTITY_EPOCH_ADMITTED],
  );
  return rows.length === 1 ? { state: 'observed', ...rows[0] } : { state: 'job-unmatched' };
}

if (import.meta.main) {
  try {
    const { databaseUrl, databasePort, operation } = await Bun.stdin.json();
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' ||
      url.port !== databasePort ||
      url.pathname !== '/rezics'
    )
      throw new Error('Walk database mismatch');
    const client = new Client({
      connectionString: url.href,
      connectionTimeoutMillis: 2_000,
      query_timeout: 3_000,
      options: '-c default_transaction_read_only=on -c statement_timeout=2000',
    });
    try {
      await client.connect();
      console.info(JSON.stringify(await readPersonMergeContinuation(client, operation)));
    } finally {
      await client.end();
    }
  } catch {
    console.info(JSON.stringify({ state: 'unavailable' }));
  }
}
