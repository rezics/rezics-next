-- Copy only roles of the actual replaced term rows; no invented payload or custody ACK.
INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
SELECT DISTINCT :partition_no::integer,:transaction_id::uuid,l.account_id,l.role
FROM semantic.erasure_locator l
WHERE l.partition_no=:partition_no::integer AND l.store='fact' AND l.record_key=ANY(:keys::bigint[])
ON CONFLICT DO NOTHING;
