INSERT INTO semantic.identity_public_output_page
(partition_no,capture_id,version,predecessor,manifest_digest,body,native_epoch,native_position,transaction_id)
VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9);
