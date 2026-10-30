SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('original',g.original,'epoch',g.epoch::text))
 FROM jsonb_to_recordset($5::jsonb) r(original uuid,terminal uuid,present boolean)
 JOIN semantic.identity_epoch_home_gate g ON g.route/16=b.partition_no AND g.destination=r.terminal
  AND g.original=r.original AND g.recorded_transaction_id=b.transaction_id WHERE r.present),'[]'::jsonb) mapping
FROM semantic.identity_epoch_bootstrap_basis b
JOIN semantic.identity_epoch_native_commit c ON
 (c.partition_no,c.transaction_id,c.epoch,c.position)=(b.partition_no,b.transaction_id,b.native_epoch,b.native_position)
 AND c.purpose='bootstrap' AND c.xmin=b.xmin
JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.native_epoch AND p.write_state='active' AND p.position>=b.native_position
WHERE b.partition_no=$1 AND b.source_partition=$2 AND b.source_generation=$3 AND b.source_transaction_id=$4;
