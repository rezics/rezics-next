WITH input AS (SELECT $1::uuid AS job_id, $2::bigint AS job_epoch, $3::integer AS partition_no)
SELECT n.plan_id::text,n.original_id::text,n.document_id::text,n.effect_key,n.source
 FROM search.identity_receiving_native_plan n
 JOIN semantic.identity_epoch_native_commit c
   ON (c.partition_no,c.transaction_id)=(n.partition_no,n.transaction_id)
  AND c.purpose='search-canonical-index' AND c.xmin=n.xmin
  AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 JOIN input ON n.job_id=input.job_id AND n.job_epoch=input.job_epoch
 WHERE NOT EXISTS (
     SELECT 1 FROM semantic.identity_epoch_receiving_plan p, input
     WHERE p.partition_no=input.partition_no AND p.job_id=input.job_id
       AND p.job_epoch=input.job_epoch AND p.effect_key=n.effect_key)
 ORDER BY n.effect_key LIMIT 1;
