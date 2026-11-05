INSERT INTO semantic.identity_public_output_accepted
(partition_no,capture_id,hold_id,binding_digest,definition_digest,binding,definition,scope_key,reservation_id,
 native_epoch,native_position,transaction_id)
VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12);
