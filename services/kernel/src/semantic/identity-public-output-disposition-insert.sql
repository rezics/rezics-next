INSERT INTO semantic.identity_public_output_disposition
(partition_no,capture_id,hold_id,binding_digest,kind,manifest_digest,seal_transaction_id,
 native_epoch,native_position,transaction_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
