WITH parameters AS (SELECT $1::integer next_partition)
SELECT coalesce(
  (SELECT partition_no FROM semantic.identity_epoch_bootstrap_home WHERE needs_work
    AND partition_no>=(SELECT next_partition FROM parameters) ORDER BY partition_no LIMIT 1),
  (SELECT partition_no FROM semantic.identity_epoch_bootstrap_home WHERE needs_work ORDER BY partition_no LIMIT 1)
) partition_no;
