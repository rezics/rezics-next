SELECT next_partition,semantic.identity_epoch_bootstrap_remaining() AS remaining
FROM semantic.identity_epoch_bootstrap_topology WHERE partition_no=0 FOR UPDATE;
