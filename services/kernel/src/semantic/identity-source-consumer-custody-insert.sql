INSERT INTO semantic.identity_epoch_source_consumer_custody
 (partition_no,receipt_key,source_digest,source_epoch,source_position,source_transaction_id,
  job_id,job_epoch,barrier_account_id,barrier_account_route,barrier_version,barrier_at,erased_role,
  binding_generation,binding_transaction_id,scope_digest,owner_epoch,transaction_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
ON CONFLICT DO NOTHING;
