WITH input AS (SELECT $1::integer AS route)
INSERT INTO access.agent_identity_reversal_settlement
(route,account_id,reversal_receipt_id,verification_receipt_id,verified,reversed,receivers,
 partition_no,owner_epoch,position,domain_generation,transaction_id,native_receipt_key)
SELECT input.route,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,p.partition_no,p.epoch,p.position+1,d.generation,$8,$9
FROM core.partition p CROSS JOIN core.history_family_domain d CROSS JOIN input
WHERE p.partition_no=input.route/16 AND p.write_state='active' AND p.moved_to IS NULL AND d.singleton
FOR SHARE OF p,d
RETURNING transaction_id;
