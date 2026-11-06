INSERT INTO semantic.identity_epoch_topology_custody(partition_no,source_partition,source_generation,source_epoch,source_transaction_id,source_position)
      VALUES(0,$1::integer,$2::bigint,$3::integer,$4::uuid,$5::bigint) ON CONFLICT DO NOTHING RETURNING source_partition;
