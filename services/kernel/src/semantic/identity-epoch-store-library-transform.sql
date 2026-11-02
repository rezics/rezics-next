-- Library's immutable pageChanges transform only. No release, undo job or receipt projection.
-- CASE guards precede UUID casts; invalid persisted shapes return a bounded invalid row.
SELECT CASE WHEN j.intent->>'kind' IN ('merge','unmerge','repoint')
            THEN j.intent->>'kind' ELSE NULL END AS kind,
 CASE WHEN jsonb_typeof(j.intent->'survivor')='string'
       AND j.intent->>'survivor' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (j.intent->>'survivor')::uuid ELSE NULL END AS survivor,
 CASE WHEN jsonb_typeof(j.intent->'original')='string'
       AND j.intent->>'original' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (j.intent->>'original')::uuid ELSE NULL END AS original,
 CASE WHEN jsonb_typeof(j.intent->'terminal')='string'
       AND j.intent->>'terminal' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (j.intent->>'terminal')::uuid ELSE NULL END AS terminal,
 j.remainder_terminal::text AS remainder_terminal
FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND c.purpose='admission'
JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=c.epoch AND p.position>=c.position
 AND p.write_state='active' AND p.moved_to IS NULL
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state IN ('pending','published')
 AND jsonb_typeof(j.intent)='object';
