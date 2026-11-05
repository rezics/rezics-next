SELECT c.partition_no,c.capture_partition,c.capture_id::text,c.original::text,c.generation::text,c.terminal::text,
 c.mapping_epoch::text,c.native_epoch,c.native_position::text,c.transaction_id::text
FROM semantic.identity_public_output_subject_cut c
JOIN semantic.identity_public_output_subject_slot slot
 USING(partition_no,capture_partition,capture_id,original)
JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (c.partition_no,c.transaction_id,c.native_epoch,c.native_position) AND n.xmin=c.xmin AND n.purpose='identity-scope-enrollment'
JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position
 AND o.event_seq=0 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=n.epoch AND p.position>=n.position
 AND p.write_state='active' AND p.moved_to IS NULL
JOIN semantic.identity_epoch_group g ON g.partition_no=c.partition_no AND g.generation=c.generation AND g.terminal=c.terminal
 AND g.ready AND g.pending_job IS NULL AND g.published_epoch=c.mapping_epoch AND g.owner_epoch=p.epoch
JOIN semantic.identity_epoch_prearm_inverse i ON i.partition_no=c.partition_no AND i.generation=c.generation
 AND i.original=c.original AND i.registration=c.registration::text AND i.capture_id=c.capture_id::text
 AND i.scope_key=$5 AND i.source_partition=c.capture_partition AND i.xmin=c.xmin AND NOT i.retired
JOIN semantic.identity_scope_inverse si ON si.partition_no=c.partition_no AND si.generation=c.generation
 AND si.original=c.original AND si.registration=c.registration AND si.capture_id=c.capture_id
 AND si.source_partition=c.capture_partition AND si.source_key=c.scope_key AND si.xmin=c.xmin
WHERE n.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::text::xid AND c.partition_no=$1 AND c.capture_partition=$2 AND c.capture_id=$3 AND c.original=$4 AND NOT slot.released;
