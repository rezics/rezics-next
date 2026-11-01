WITH parameters AS (SELECT $6::uuid AS current_transaction)
SELECT d.kind,d.manifest_digest,d.seal_transaction_id::text,d.native_epoch,d.native_position::text,
 d.transaction_id::text,s.successor_hold_id::text,s.cancellation_epoch::text,s.purpose,
 (d.transaction_id=(SELECT current_transaction FROM parameters) AND s.native_xid=pg_current_xact_id_if_assigned() AND d.xmin=s.xmin
  AND d.native_position=p.position+1) AS staged
FROM semantic.identity_public_output_disposition d
JOIN semantic.identity_public_output_stage s USING(partition_no,capture_id,hold_id,binding_digest,kind,
 native_epoch,native_position,transaction_id)
JOIN semantic.identity_public_output_accepted a USING(partition_no,capture_id)
JOIN semantic.identity_public_output_fence f ON f.partition_no=d.partition_no AND f.capture_id=d.capture_id AND f.kind=d.kind
JOIN core.partition p ON p.partition_no=d.partition_no AND p.epoch=d.native_epoch
 AND p.epoch=a.native_epoch AND p.write_state='active' AND p.moved_to IS NULL
LEFT JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id,n.epoch,n.position)=
 (d.partition_no,d.transaction_id,d.native_epoch,d.native_position) AND n.xmin=d.xmin AND n.xmin=s.xmin
 AND n.purpose=s.purpose
LEFT JOIN core.outbox o ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position
 AND o.event_seq=0 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
LEFT JOIN semantic.identity_public_output_transition t ON t.partition_no=d.partition_no AND t.capture_id=d.capture_id
WHERE d.partition_no=$1 AND d.capture_id=$2 AND d.hold_id=$3 AND d.binding_digest=$4
 AND (d.native_epoch,d.native_position,d.transaction_id)=($7,$8,$5)
 AND s.original_receiving_epoch=(a.binding->'tuple'->'identity'->>'receivingEpoch')::bigint
 AND s.manifest_digest IS NOT DISTINCT FROM d.manifest_digest
 AND s.seal_transaction_id IS NOT DISTINCT FROM d.seal_transaction_id
 AND ((d.transaction_id=(SELECT current_transaction FROM parameters) AND s.native_xid=pg_current_xact_id_if_assigned()
       AND d.xmin=s.xmin AND d.native_position=p.position+1)
 OR (n.transaction_id IS NOT NULL AND p.position>=n.position AND o.position IS NOT NULL
  AND s.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
  AND (t.transaction_id,t.native_epoch,t.native_position,t.kind)=(d.transaction_id,d.native_epoch,d.native_position,d.kind)
  AND t.xmin=d.xmin AND t.successor_hold_id IS NOT DISTINCT FROM s.successor_hold_id))
FOR SHARE OF d,s,a,f,p;
