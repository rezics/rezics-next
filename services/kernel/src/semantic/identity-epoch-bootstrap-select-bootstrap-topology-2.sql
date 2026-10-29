SELECT remaining,coalesce(
  (SELECT source_partition FROM semantic.identity_epoch_bootstrap_topology_home WHERE NOT closed AND source_partition>=t.next_partition ORDER BY source_partition LIMIT 1),
  (SELECT source_partition FROM semantic.identity_epoch_bootstrap_topology_home WHERE NOT closed ORDER BY source_partition LIMIT 1)
) next_partition FROM semantic.identity_epoch_bootstrap_topology t WHERE partition_no=0;
