SELECT count(*)::integer n FROM semantic.identity_epoch_mapping
      WHERE original=ANY($1::uuid[]) AND route=ANY($2::integer[]) AND control_partition=$3;
