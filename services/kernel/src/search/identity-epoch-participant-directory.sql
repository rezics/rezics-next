WITH input AS (SELECT $1::integer AS partition_no, $2::uuid AS job_id, $3::bigint AS job_epoch)
SELECT
  (SELECT count(*)::integer FROM search.identity_receiving_native_scope_pending q, input
    WHERE q.partition_no=input.partition_no AND q.job_id=input.job_id AND q.job_epoch=input.job_epoch) AS pending,
  (SELECT count(*)::integer FROM (
      SELECT c.original FROM semantic.identity_epoch_change c, input
       WHERE c.partition_no=input.partition_no AND c.job_id=input.job_id
      UNION
      SELECT o.original FROM semantic.identity_epoch_original o
      JOIN semantic.identity_epoch_input i
        ON o.generation=i.generation AND o.terminal=i.terminal AND o.present
       AND o.partition_no=i.control_partition
      JOIN input ON i.partition_no=input.partition_no AND i.job_id=input.job_id
    ) originals) AS originals,
  (SELECT count(DISTINCT p.binding->>'original')::integer
    FROM semantic.identity_epoch_receiving_plan p
    JOIN semantic.identity_epoch_native_commit c
      ON (c.partition_no,c.transaction_id)=(p.partition_no,p.transaction_id)
     AND c.purpose='identity-receiving-plan' AND c.xmin=p.xmin
     AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
    JOIN input ON p.partition_no=input.partition_no AND p.job_id=input.job_id AND p.job_epoch=input.job_epoch
   WHERE p.binding->>'step'='search-canonical-index') AS plans;
