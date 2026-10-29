SELECT route,original::text,terminal::text,source_revision::text,present,previous_partition,previous_terminal::text
      FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=$1 AND transaction_id=$2
      ORDER BY route,original,terminal LIMIT 100;
