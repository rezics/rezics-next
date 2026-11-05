INSERT INTO semantic.identity_public_output_consumer
(partition_no,capture_id,consumer_id,native_epoch,native_position,transaction_id)
VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING;
