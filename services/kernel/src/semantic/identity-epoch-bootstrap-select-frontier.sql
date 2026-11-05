WITH parameters AS (SELECT $1::integer after_partition), frontier AS (
  SELECT source_partition FROM semantic.identity_epoch_bootstrap_topology_home
  WHERE partition_no=0 AND NOT closed AND source_partition >= (SELECT after_partition FROM parameters)
  ORDER BY source_partition LIMIT 100
), wrapped AS (
  SELECT source_partition FROM semantic.identity_epoch_bootstrap_topology_home
  WHERE partition_no=0 AND NOT closed AND NOT EXISTS (SELECT 1 FROM frontier)
  ORDER BY source_partition LIMIT 100
)
SELECT source_partition FROM frontier UNION ALL SELECT source_partition FROM wrapped
ORDER BY source_partition;
