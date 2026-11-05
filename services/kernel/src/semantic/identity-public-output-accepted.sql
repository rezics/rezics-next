SELECT a.capture_id::text,a.binding,a.definition,a.scope_key,a.reservation_id,
 a.native_epoch,a.native_position::text,a.transaction_id::text,
 p.epoch AS owner_epoch,p.position::text AS owner_position
FROM semantic.identity_public_output_accepted a
JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (a.partition_no,a.transaction_id,a.native_epoch,a.native_position)
 AND n.xmin=a.xmin AND n.purpose='identity-public-output-capture'
JOIN core.partition p ON p.partition_no=a.partition_no AND p.epoch=n.epoch
 AND p.write_state='active' AND p.moved_to IS NULL AND p.position>=n.position
JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
 AND o.type='com.rezics.semantic.public-output.capture.v1' AND o.xmin=n.xmin
JOIN library.native_public_output_binding b ON b.partition_no=a.partition_no AND b.capture_id=a.capture_id
 AND b.hold_id=a.hold_id AND b.binding_digest=a.binding_digest AND b.payload=a.binding AND b.xmin=a.xmin
 AND b.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
WHERE a.partition_no=$1 AND a.capture_id=$2;
