WITH closed AS (
  UPDATE semantic.identity_epoch_bootstrap_topology_home SET closed=true WHERE source_partition=$1 AND $2::integer=1
)
UPDATE semantic.identity_epoch_bootstrap_topology SET next_partition=($1+1)%4096,remaining=remaining-$2 WHERE partition_no=0;
