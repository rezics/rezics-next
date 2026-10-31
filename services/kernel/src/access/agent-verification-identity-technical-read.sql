SELECT t.*
FROM access.agent_identity_technical_source t
JOIN core.partition p ON p.partition_no=t.source_partition AND p.epoch=t.receiving_epoch AND p.write_state='active'
JOIN core.history_family_domain d ON d.singleton AND d.generation=t.domain_generation
WHERE t.route=$1 AND t.account_id=$2 AND t.direction=$3 AND t.receipt_id=$4
 AND (p.position>=t.receiving_position OR
   (t.xmin::text=pg_current_xact_id()::text AND t.receiving_position=p.position+1))
FOR SHARE OF t,p;
