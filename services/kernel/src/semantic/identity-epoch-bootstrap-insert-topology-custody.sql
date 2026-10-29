INSERT INTO semantic.identity_epoch_topology_custody(source_partition,source_generation,source_epoch)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_partition;
