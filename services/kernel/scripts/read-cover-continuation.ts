/** The admitted Importer walk calls this once, after the first failed seed and before teardown. */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { readReceiptKeyRing, receiptKeyCandidates } from '../src/command/receipt-key.ts';
import { partitionOf, routeOf } from '../src/route/contract.ts';

type JournalRow = {
  record_key: string;
  subject: string | null;
  post_key: string | null;
  media_id: string | null;
  observed_id: string | null;
  observed_state: string | null;
};

function deferredCovers(path: string, generation: string) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    // Same index and page size as RunStore.pageDeferredCovers, with one extra row to show truncation.
    return db.query<JournalRow, [string]>(`
      SELECT e.record_key, b.subject, m.key AS post_key,
             json_extract(m.accepted, '$.media.id') AS media_id,
             json_extract(m.status, '$.media.id') AS observed_id,
             json_extract(m.status, '$.media.state') AS observed_state
      FROM run_entries AS e INDEXED BY run_cover_pending
      LEFT JOIN binding_records AS b ON (b.source,b.external_id)=(e.source,e.record_key) AND b.state='bound'
      LEFT JOIN binding_media AS m ON (m.source,m.external_id,m.key)=(b.source,b.external_id,b.cover_key)
        AND json_extract(m.accepted, '$.media.containerId')=b.subject
        AND json_extract(m.status, '$.media.containerId')=b.subject
      WHERE e.source='bangumi_cross_media' AND e.run_id=? AND e.cover_pending=1
      ORDER BY e.record_key LIMIT 101
    `).all(generation);
  } finally {
    db.close();
  }
}

// Find the original outbox tuple through the reservation receipt. Later media transitions replace transaction_id.
// Workflow identities follow events/effects.ts and content/work-contract.ts. Read only the two exact DBOS rows.
const readNative = `
WITH receipt AS MATERIALIZED (
  SELECT epoch,position,response->>'mediaId'=$2::text AS matches
  FROM core.receipt
  WHERE partition_no=$6 AND principal_kind='account' AND principal_id=$3
    AND command_kind='content.media.importFromUrl' AND idempotency_key=ANY($5::text[])
  LIMIT 2
), requested AS MATERIALIZED (
  SELECT o.epoch,o.position,format('fx:%s:%s:%s:%s:',o.epoch,o.partition_no,o.position,o.event_seq) AS prefix
  FROM receipt AS r JOIN core.outbox AS o ON (o.partition_no,o.position,o.epoch)=($6,r.position,r.epoch)
  WHERE r.matches AND (SELECT count(*) FROM receipt)=1
    AND o.type='com.rezics.content.media.import-requested.v1' AND o.subject=$2
    AND o.data=jsonb_build_object('mediaId',$2::text) AND o.event_count<=1000
  LIMIT 2
), source AS (
  SELECT * FROM requested WHERE (SELECT count(*) FROM requested)=1
), work AS (
  SELECT expected.stage,
    CASE WHEN w.workflow_uuid IS NULL THEN 'missing'
         WHEN w.name IS DISTINCT FROM expected.name THEN 'mismatch'
         WHEN w.status='ENQUEUED' AND w.queue_name IS DISTINCT FROM expected.queue THEN 'queue-mismatch'
         WHEN w.status IN ('ENQUEUED','PENDING','SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')
           THEN lower(w.status) ELSE 'unknown' END AS status,
    steps.completed,steps.failed
  FROM source AS s CROSS JOIN LATERAL (VALUES
    ('outer',s.prefix || 'content_url_import','effects','effect','effect.run'),
    ('inner',s.prefix || 'content_import_from_url_' || $2,'import','content.importFromUrl','content.import.step')
  ) AS expected(stage,id,queue,name,step)
  LEFT JOIN dbos.workflow_status AS w ON w.workflow_uuid=expected.id
  CROSS JOIN LATERAL (
    SELECT (count(*) FILTER (WHERE error IS NULL))::int AS completed,
           (count(*) FILTER (WHERE error IS NOT NULL))::int AS failed
    FROM dbos.operation_outputs WHERE workflow_uuid=w.workflow_uuid AND function_name=expected.step
  ) AS steps
)
SELECT COALESCE((SELECT CASE WHEN (container_id,uploader_id,reservation_request_id,purpose)=($7::uuid,$3,$4,'cover')
                             THEN state ELSE 'mismatch' END
                 FROM content.media WHERE route=$1 AND media_id=$2::uuid),'missing') AS media,
       (SELECT CASE WHEN erased THEN 'erased' WHEN taken_down THEN 'taken-down'
                    WHEN collection_pending THEN 'collection-pending' ELSE 'open' END
        FROM content.media WHERE route=$1 AND media_id=$2::uuid) AS "mediaGuard",
       (SELECT count(*)::int FROM receipt) AS "receiptCount",
       (SELECT count(*)::int FROM receipt WHERE matches) AS "matchingReceiptCount",
       (SELECT count(*)::int FROM requested) AS "eventCount",
       (SELECT CASE WHEN c.epoch IS NULL THEN 'unset' WHEN c.position<s.position THEN 'behind'
                    WHEN c.epoch<s.epoch THEN 'mismatch' ELSE 'reached' END
        FROM source AS s LEFT JOIN core.consumer_checkpoint AS c ON c.partition_no=$6 AND c.consumer='effects')
          AS checkpoint,
       (SELECT jsonb_object_agg(stage,jsonb_build_object('status',status,'completed',completed,'failed',failed))
        FROM work) AS workflows
`;

export async function readCoverContinuation(input: {
  journal: string;
  generation: string;
  keyDigest: string;
  account: string;
  databasePort: string;
  kernelEnvironment: Record<string, string>;
}) {
  const rows = deferredCovers(input.journal, input.generation);
  if (rows.length > 100) return { state: 'journal-page-limit' };
  const deferred = rows.length;
  // The failure digest names the staged record. Only the current binding names its accepted POST.
  const matches = rows.filter((row) => createHash('sha256').update(row.record_key).digest('hex') === input.keyDigest);
  const cover = matches[0];
  if (matches.length !== 1 || !cover) return { state: 'record-unmatched', deferred };
  const { media_id: media, post_key: postKey, subject } = cover;
  const route = routeOf(media ?? '');
  if (route === null || !postKey || !subject || cover.observed_id !== media || cover.observed_state !== 'reserved')
    return { state: 'binding-unmatched', deferred };

  const url = new URL(input.kernelEnvironment.DATABASE_URL!);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== input.databasePort ||
    url.pathname !== '/rezics'
  )
    return { state: 'database-unmatched', deferred };

  const keys = receiptKeyCandidates(
    readReceiptKeyRing(input.kernelEnvironment),
    'content.media.importFromUrl',
    { kind: 'account', id: input.account },
    postKey,
  );
  const client = new Client({
    connectionString: url.href,
    connectionTimeoutMillis: 2_000,
    query_timeout: 3_000,
    options: '-c default_transaction_read_only=on -c statement_timeout=2000',
  });
  try {
    await client.connect();
    const { rows: native } = await client.query(readNative, [
      route,
      media,
      input.account,
      postKey,
      keys,
      partitionOf(route),
      subject,
    ]);
    return { state: 'observed', deferred, ...native[0] };
  } catch {
    return { state: 'native-unavailable', deferred };
  } finally {
    await client.end();
  }
}
