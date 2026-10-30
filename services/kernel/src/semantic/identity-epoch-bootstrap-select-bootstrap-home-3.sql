WITH parameters AS (SELECT $1::integer next_partition)
SELECT coalesce(
  (SELECT partition_no FROM semantic.identity_epoch_bootstrap_home WHERE needs_work
    AND partition_no>=(SELECT next_partition FROM parameters) ORDER BY partition_no LIMIT 1),
  (SELECT partition_no FROM semantic.identity_epoch_bootstrap_home WHERE needs_work ORDER BY partition_no LIMIT 1),
  (SELECT route/16 FROM semantic.identity_epoch_dirty WHERE revision>captured_revision
    AND route>=(SELECT next_partition FROM parameters)*16 ORDER BY route,original LIMIT 1),
  (SELECT route/16 FROM semantic.identity_epoch_dirty WHERE revision>captured_revision ORDER BY route,original LIMIT 1)
) partition_no;
