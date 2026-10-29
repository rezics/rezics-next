SELECT DISTINCT g.* FROM semantic.identity_epoch_mapping m
      JOIN semantic.identity_epoch_group g ON (g.partition_no,g.terminal)=(m.control_partition,m.control_group)
      WHERE m.original=ANY($1::uuid[]) AND m.route=ANY($2::integer[]) AND m.control_partition=$3;
