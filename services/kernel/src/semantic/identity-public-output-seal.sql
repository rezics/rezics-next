SELECT s.manifest_digest,s.version::text,s.raw_count::text,s.canonical_count::text,
 s.native_epoch,s.native_position::text,s.transaction_id::text
FROM semantic.identity_public_output_seal s
JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (s.partition_no,s.transaction_id,s.native_epoch,s.native_position)
 AND n.xmin=s.xmin AND n.purpose='identity-public-output-capture'
JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=n.epoch
 AND p.write_state='active' AND p.moved_to IS NULL AND p.position>=n.position
JOIN core.outbox o ON o.partition_no=n.partition_no AND o.position=n.position AND o.epoch=n.epoch AND o.event_seq=0
 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
WHERE s.partition_no=$1 AND s.capture_id=$2;
