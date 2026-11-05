INSERT INTO semantic.identity_epoch_source_consumer_terminal
 (partition_no,custody_key,sequence,previous_sequence,state,directory_after,ticket_key,effect_after,seal_digest,
  scope_partition,scope_epoch,scope_position,scope_transaction_id,replay_generation,undo_generation,
  restore_generation,owner_epoch,transaction_id,receiving_partition,receiving_epoch,receiving_position,receiving_transaction_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22);
