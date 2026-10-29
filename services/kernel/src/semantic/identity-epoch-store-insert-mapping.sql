INSERT INTO semantic.identity_epoch_mapping(route,original,terminal,epoch,origin,recorded_transaction_id,control_partition,control_group,owner_epoch)
      VALUES ($1,$2,$2,$3,'creation',$4,$5,$2,$3);
