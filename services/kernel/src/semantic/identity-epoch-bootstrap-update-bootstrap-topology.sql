WITH parameters AS (SELECT $1::integer p1,$2::integer p2),
closed AS (
  UPDATE semantic.identity_epoch_bootstrap_topology_home SET closed=true WHERE source_partition=(SELECT p1 FROM parameters) AND (SELECT p2 FROM parameters)::integer=1
)
UPDATE semantic.identity_epoch_bootstrap_topology SET next_partition=((SELECT p1 FROM parameters)+1)%4096,remaining=remaining-(SELECT p2 FROM parameters) WHERE partition_no=0;
