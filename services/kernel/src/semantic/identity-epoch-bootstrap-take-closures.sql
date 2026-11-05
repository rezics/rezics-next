WITH received AS (
  INSERT INTO semantic.identity_epoch_topology_custody
    (partition_no,source_partition,source_generation,source_epoch,source_transaction_id,source_position)
  SELECT 0,r.source_partition,r.source_generation,r.source_epoch,r.source_transaction_id,r.source_position
  FROM jsonb_to_recordset($1::jsonb) AS r(source_partition integer,source_generation bigint,
    source_epoch integer,source_transaction_id uuid,source_position bigint)
  ON CONFLICT DO NOTHING RETURNING source_partition
), closed AS (
  UPDATE semantic.identity_epoch_bootstrap_topology_home h SET closed=true
  FROM received r WHERE h.partition_no=0 AND h.source_partition=r.source_partition AND NOT h.closed
  RETURNING h.source_partition
)
UPDATE semantic.identity_epoch_bootstrap_topology SET remaining=remaining-(SELECT count(*) FROM closed)
WHERE partition_no=0;
