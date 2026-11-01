INSERT INTO library.native_public_output_binding
 (route,collection_id,capture_id,hold_id,incarnation,output_generation,activation_transaction_id,
  activation_position,activation_source_generation,owner_epoch,accepted_position,accepted_transaction_id,
  receiving_epoch,effect_key,definition_digest,binding_digest,payload)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$16)
RETURNING native_xid::text;
