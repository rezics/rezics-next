WITH parameters AS (SELECT $1::uuid job,$2::integer home,$3::uuid transaction_id,$4::integer epoch,$5::bigint position)
UPDATE semantic.identity_epoch_admission_plan SET waiting=false,acquired_transaction_id=(SELECT transaction_id FROM parameters),
 acquired_epoch=(SELECT epoch FROM parameters),acquired_position=(SELECT position FROM parameters)
WHERE partition_no=$6 AND job_id=(SELECT job FROM parameters) AND resource_home=(SELECT home FROM parameters)
 AND (acquired_transaction_id IS NULL OR acquired_transaction_id=(SELECT transaction_id FROM parameters));
