WITH input AS (SELECT $1::uuid job,$2::integer resource_home,$3::uuid native_transaction,
 $4::integer native_epoch,$5::bigint native_position,$6::integer home)
UPDATE semantic.identity_epoch_admission_plan SET waiting=false,
 prepared_transaction_id=(SELECT native_transaction FROM input),
 prepared_epoch=(SELECT native_epoch FROM input),prepared_position=(SELECT native_position FROM input)
WHERE partition_no=(SELECT home FROM input) AND job_id=(SELECT job FROM input)
 AND resource_home=(SELECT resource_home FROM input)
 AND (prepared_transaction_id IS NULL OR prepared_transaction_id=(SELECT native_transaction FROM input));
