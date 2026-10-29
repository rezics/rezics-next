WITH parameters AS (SELECT $1::integer home,$2::uuid transaction_id,$3::uuid job,$4::text stage)
INSERT INTO semantic.identity_epoch_admission_receipt(partition_no,transaction_id,native_epoch,native_position,job_id,job_epoch,scope_digest,stage,version)
SELECT a.partition_no,c.transaction_id,c.epoch,c.position,a.job_id,a.job_epoch,a.scope_digest,(SELECT stage FROM parameters),1
FROM semantic.identity_epoch_admission_attempt a JOIN semantic.identity_epoch_native_commit c
 ON c.partition_no=a.partition_no AND c.transaction_id=(SELECT transaction_id FROM parameters) AND c.purpose='admission'
WHERE a.partition_no=(SELECT home FROM parameters) AND a.job_id=(SELECT job FROM parameters) AND a.state=(SELECT stage FROM parameters);
