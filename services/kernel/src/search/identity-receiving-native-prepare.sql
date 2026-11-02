WITH prepared AS (INSERT INTO search.identity_receiving_native_plan
 (partition_no,plan_id,job_id,job_epoch,original_id,document_id,physical_target,
 effect_key,scope_digest,source,obligations,action_digest,transaction_id,initial_copy_count)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)
ON CONFLICT (partition_no,plan_id) DO NOTHING
RETURNING partition_no,physical_target,plan_id)
INSERT INTO search.identity_receiving_native_pending(partition_no,physical_target,plan_id)
SELECT partition_no,physical_target,plan_id FROM prepared RETURNING plan_id;
