SELECT g.state,g.original_epoch::text,g.receiving_epoch::text,g.enrolled_count::text
FROM semantic.identity_public_output_gate g
JOIN semantic.identity_public_output_accepted a USING(partition_no,capture_id)
JOIN core.partition p ON p.partition_no=g.partition_no AND p.epoch=a.native_epoch
 AND p.write_state='active' AND p.moved_to IS NULL
LEFT JOIN semantic.identity_public_output_fence f ON f.partition_no=g.partition_no AND f.capture_id=g.capture_id
 AND f.kind=g.state AND f.transaction_id=g.transaction_id AND f.native_epoch=g.native_epoch
 AND f.native_position=g.native_position AND f.xmin=g.xmin
LEFT JOIN semantic.identity_epoch_native_commit n ON n.partition_no=g.partition_no AND n.transaction_id=g.transaction_id
 AND n.epoch=g.native_epoch AND n.position=g.native_position AND n.xmin=g.xmin
 AND n.purpose=CASE g.state WHEN 'applied' THEN 'identity-public-output-applied' ELSE 'identity-public-output-cancelled' END
LEFT JOIN core.outbox o ON o.partition_no=n.partition_no AND o.position=n.position AND o.epoch=n.epoch
 AND o.event_seq=0 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
WHERE g.partition_no=$1 AND g.capture_id=$2
 AND g.original_epoch=(a.binding->'tuple'->'identity'->>'receivingEpoch')::bigint
 AND ((g.state='open' AND g.receiving_epoch=g.original_epoch AND g.transaction_id IS NULL)
 OR (g.state IN ('applied','cancelled') AND g.receiving_epoch=g.original_epoch+1 AND f.capture_id IS NOT NULL
  AND ((g.transaction_id=$3 AND g.native_xid=pg_current_xact_id_if_assigned()
        AND g.native_epoch=p.epoch AND g.native_position=p.position+1)
    OR (n.transaction_id IS NOT NULL AND p.position>=n.position AND o.position IS NOT NULL
        AND g.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()))))
FOR UPDATE OF g FOR SHARE OF p;
