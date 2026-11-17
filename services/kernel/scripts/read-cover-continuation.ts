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
    return db
      .query<JournalRow, [string]>(`
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
    `)
      .all(generation);
  } finally {
    db.close();
  }
}

// Later media transitions replace transaction_id. Anchor the read at the reservation receipt instead.
// Workflow identities follow events/effects.ts and content/work-contract.ts.
const readNative = `
WITH media AS MATERIALIZED (
  SELECT state,(container_id,uploader_id,reservation_request_id,purpose)=($7::uuid,$3,$4,'cover') AS owned,
         CASE WHEN erased THEN 'erased' WHEN taken_down THEN 'taken-down'
              WHEN collection_pending THEN 'collection-pending' ELSE 'open' END AS guard
  FROM content.media WHERE route=$1 AND media_id=$2::uuid
), receipt AS MATERIALIZED (
  SELECT epoch,position,response->>'mediaId'=$2::text AS matches
  FROM core.receipt
  WHERE partition_no=$6 AND principal_kind='account' AND principal_id=$3
    AND command_kind='content.media.importFromUrl' AND idempotency_key=ANY($5::text[])
  LIMIT 2
), requested AS MATERIALIZED (
  SELECT o.epoch,o.position,o.event_seq
  FROM receipt AS r JOIN core.outbox AS o ON (o.partition_no,o.position,o.epoch)=($6,r.position,r.epoch)
  WHERE r.matches AND (SELECT count(*) FROM receipt)=1
    AND o.type='com.rezics.content.media.import-requested.v1' AND o.subject=$2::text
    AND o.data=jsonb_build_object('mediaId',$2::text) AND o.event_count<=1000
  LIMIT 2
), request_source AS (
  SELECT * FROM requested WHERE (SELECT count(*) FROM requested)=1
), uploaded AS MATERIALIZED (
  -- The native URL job emits a single-event command. Probe sequence zero at most once per position.
  SELECT r.epoch,o.position,o.event_seq
  FROM request_source AS r CROSS JOIN generate_series(1,100) AS offsets(n)
  CROSS JOIN LATERAL (
    SELECT position,event_seq FROM core.outbox
    WHERE (partition_no,position,event_seq)=($6,r.position+offsets.n,0) AND epoch=r.epoch
      AND event_count=1 AND payload_state='present' AND type='com.rezics.content.media.uploaded.v1'
      AND subject=$2::text AND data=jsonb_build_object('mediaId',$2::text,'containerId',$7::uuid,'actorId',$3::uuid)
    LIMIT 1
  ) AS o
  WHERE $8='uploaded' AND EXISTS (SELECT 1 FROM media WHERE owned)
  LIMIT 2
), source AS (
  SELECT epoch,position,format('fx:%s:%s:%s:%s:',epoch,$6,position,event_seq) AS prefix
  FROM (
    SELECT * FROM request_source WHERE $8='reserved'
    UNION ALL
    SELECT * FROM uploaded WHERE (SELECT count(*) FROM uploaded)=1
  ) AS matched
), work AS (
  SELECT expected.stage,workflow.status,steps.completed,steps.failed
  FROM source AS s CROSS JOIN LATERAL (VALUES
    ('reserved','outer','content_url_import','effects','effect','effect.run',NULL),
    ('reserved','inner','content_import_from_url_' || $2::text,'import','content.importFromUrl','content.import.step',NULL),
    ('uploaded','outer','content_media_image','media','effect','effect.run','content_media_image:' || $6::text),
    ('uploaded','inner','content_image','media','content.image','content.image.step',$6::text)
  ) AS expected(journal_state,stage,suffix,queue,name,step,partition_key)
  LEFT JOIN dbos.workflow_status AS w ON w.workflow_uuid=s.prefix || expected.suffix
  CROSS JOIN LATERAL (
    SELECT CASE WHEN w.workflow_uuid IS NULL THEN 'missing'
                WHEN w.name IS DISTINCT FROM expected.name THEN 'mismatch'
                WHEN (w.status='ENQUEUED' OR (expected.partition_key IS NOT NULL AND w.queue_name IS NOT NULL))
                  AND w.queue_name IS DISTINCT FROM expected.queue THEN 'queue-mismatch'
                WHEN expected.partition_key IS NOT NULL AND w.queue_partition_key IS DISTINCT FROM expected.partition_key
                  THEN 'partition-mismatch'
                WHEN w.status IN ('ENQUEUED','PENDING','SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')
                  THEN lower(w.status) ELSE 'unknown' END AS status
  ) AS workflow
  CROSS JOIN LATERAL (
    SELECT (count(*) FILTER (WHERE error IS NULL))::int AS completed,
           (count(*) FILTER (WHERE error IS NOT NULL))::int AS failed
    FROM dbos.operation_outputs WHERE workflow_uuid=w.workflow_uuid AND function_name=expected.step
      AND (expected.partition_key IS NULL OR workflow.status NOT IN ('mismatch','queue-mismatch','partition-mismatch'))
  ) AS steps
  WHERE expected.journal_state=$8
)
SELECT COALESCE((SELECT CASE WHEN owned THEN state ELSE 'mismatch' END FROM media),'missing') AS media,
       (SELECT guard FROM media WHERE $8='reserved' OR owned) AS "mediaGuard",
       (SELECT count(*)::int FROM receipt) AS "receiptCount",
       (SELECT count(*)::int FROM receipt WHERE matches) AS "matchingReceiptCount",
       (SELECT count(*)::int FROM requested) AS "eventCount",
       (SELECT CASE WHEN c.epoch IS NULL THEN 'unset' WHEN c.position<s.position THEN 'behind'
                    WHEN c.epoch<s.epoch THEN 'mismatch' ELSE 'reached' END
        FROM source AS s LEFT JOIN core.consumer_checkpoint AS c ON c.partition_no=$6 AND c.consumer='effects')
          AS checkpoint,
       (SELECT jsonb_object_agg(stage,jsonb_build_object('status',status,'completed',completed,'failed',failed))
        FROM work) AS workflows,
       CASE WHEN $8='uploaded' THEN jsonb_build_object(
         'event', CASE WHEN NOT EXISTS (SELECT 1 FROM media WHERE owned) THEN 'media-unmatched'
                       WHEN NOT EXISTS (SELECT 1 FROM request_source) THEN 'request-unmatched'
                       WHEN (SELECT count(*) FROM uploaded)=0 THEN 'inconclusive-cap'
                       WHEN (SELECT count(*) FROM uploaded)=1 THEN 'matched' ELSE 'ambiguous' END,
         -- The native variant slot index allows six widths for each of two formats.
         'variantCount', (SELECT (SELECT count(*)::int FROM (
           SELECT 1 FROM content.media_variant WHERE route=$1 AND media_id=$2::uuid LIMIT 12
         ) AS variants) FROM source)
       ) END AS upload
`;

async function readCoverContinuation(input: {
  journal: string;
  generation: string;
  keyDigest: string;
  mediaState: 'reserved' | 'uploaded';
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
  if (
    route === null ||
    !postKey ||
    !subject ||
    cover.observed_id !== media ||
    !['reserved', 'uploaded'].includes(input.mediaState) ||
    cover.observed_state !== input.mediaState
  )
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
      input.mediaState,
    ]);
    const { upload, ...observation } = native[0]!;
    return { state: 'observed', deferred, ...observation, ...(upload === null ? {} : { upload }) };
  } catch {
    return { state: 'native-unavailable', deferred };
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  try {
    const input = (await Bun.stdin.json()) as Parameters<typeof readCoverContinuation>[0];
    console.info(JSON.stringify(await readCoverContinuation(input)));
  } catch {
    console.info(JSON.stringify({ state: 'unavailable' }));
  }
}
