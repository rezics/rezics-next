INSERT INTO semantic.identity_epoch_topology_custody(source_partition,source_generation,source_epoch,source_transaction_id,source_position)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING source_partition;
