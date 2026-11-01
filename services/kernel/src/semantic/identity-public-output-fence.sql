SELECT f.kind,f.native_epoch,f.native_position::text,f.transaction_id::text
FROM semantic.identity_public_output_fence f
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=f.partition_no AND n.transaction_id=f.transaction_id
 AND n.epoch=f.native_epoch AND n.position=f.native_position AND n.xmin=f.xmin
 AND n.purpose=CASE f.kind WHEN 'applied' THEN 'identity-public-output-applied' ELSE 'identity-public-output-cancelled' END
JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position
 AND p.write_state='active' AND p.moved_to IS NULL
JOIN core.outbox o ON o.partition_no=n.partition_no AND o.position=n.position AND o.epoch=n.epoch
 AND o.event_seq=0 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
WHERE f.partition_no=$1 AND f.capture_id=$2;
