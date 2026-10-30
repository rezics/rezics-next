WITH parameters AS (SELECT $1::integer p1,$2::integer p2),
closed AS (
  UPDATE semantic.identity_epoch_bootstrap_topology_home SET closed=true WHERE partition_no=0 AND source_partition=(SELECT p1 FROM parameters) AND (SELECT p2 FROM parameters)::integer=1
)
UPDATE semantic.identity_epoch_bootstrap_topology SET remaining=remaining-(SELECT p2 FROM parameters) WHERE partition_no=0;
