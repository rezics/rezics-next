INSERT INTO semantic.identity_scope_consumer_fence
(partition_no,source_key,scope_id,registration,capture_id,job_id,job_epoch,attempt,
 source_generation,completion_version,seal_digest,native_epoch,native_position,transaction_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14);
