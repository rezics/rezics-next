-- Copy only roles of the actual replaced term rows; no invented payload or custody ACK.
WITH input AS (SELECT :partition_no::integer AS partition_no)
INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
SELECT DISTINCT input.partition_no,:transaction_id::uuid,l.account_id,l.role
FROM semantic.erasure_locator l CROSS JOIN input
WHERE l.partition_no=input.partition_no AND l.store='fact' AND l.record_key=ANY(:keys::bigint[])
ON CONFLICT DO NOTHING;
