INSERT INTO library.native_public_output_transition
 (partition_no,capture_id,hold_id,binding_digest,kind,successor_hold_id,cancellation_epoch,
  epoch,position,transaction_id,purpose,payload)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12);
