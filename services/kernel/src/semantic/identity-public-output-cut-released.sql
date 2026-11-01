SELECT 1 FROM semantic.identity_public_output_subject_release r
JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (r.partition_no,r.transaction_id,r.native_epoch,r.native_position) AND n.xmin=r.xmin
 AND n.purpose='identity-scope-directory-release'
JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position
 AND o.event_seq=0 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
JOIN core.partition p ON p.partition_no=r.partition_no AND p.epoch=n.epoch AND p.position>=n.position
 AND p.write_state='active' AND p.moved_to IS NULL
WHERE n.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::text::xid AND r.partition_no=$1 AND r.capture_partition=$2 AND r.capture_id=$3 AND r.original=$4;
