SELECT * FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=ANY($2::uuid[]) ORDER BY terminal FOR UPDATE;
