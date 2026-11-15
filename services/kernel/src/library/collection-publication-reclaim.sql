-- Cancellation has independently closed this managed capture and its native holding slot.
-- Recheck monotone supersession and all other retained references under the source lock on every page.
SELECT g.generation::text AS generation
FROM library.collection c
JOIN library.collection_source_output g ON g.route=c.route AND g.collection_id=c.collection_id
JOIN library.native_public_output_binding b
 ON b.partition_no=(c.route >> 4) AND b.capture_id=g.generation
 AND b.route=g.route AND b.collection_id=g.collection_id AND b.output_generation=g.generation
JOIN library.native_public_output_hold h
 ON h.partition_no=b.partition_no AND h.hold_id=b.hold_id AND h.capture_id=b.capture_id
JOIN library.native_public_output_transition t
 ON t.partition_no=b.partition_no AND t.hold_id=b.hold_id AND t.capture_id=b.capture_id
 AND t.binding_digest=b.binding_digest AND t.kind='cancelled' AND t.transaction_id=h.consumed_by
JOIN library.native_public_output_receiving f
 ON f.partition_no=b.partition_no AND f.capture_id=b.capture_id AND f.state='cancelled'
 AND f.receiving_epoch=t.cancellation_epoch AND f.transaction_id=t.transaction_id
JOIN semantic.identity_public_output_disposition d
 ON d.partition_no=t.partition_no AND d.capture_id=t.capture_id AND d.hold_id=t.hold_id
 AND d.binding_digest=t.binding_digest AND d.kind='cancelled' AND d.transaction_id=t.transaction_id
 AND d.native_epoch=t.epoch AND d.native_position=t.position
JOIN semantic.identity_public_output_transition sd
 ON sd.partition_no=d.partition_no AND sd.capture_id=d.capture_id AND sd.kind=d.kind
 AND sd.transaction_id=d.transaction_id AND sd.native_epoch=d.native_epoch AND sd.native_position=d.native_position
JOIN semantic.identity_epoch_native_commit n
 ON n.partition_no=t.partition_no AND n.transaction_id=t.transaction_id AND n.epoch=t.epoch AND n.position=t.position
 AND n.purpose=t.purpose AND n.xmin=t.xmin AND n.xmin=d.xmin AND n.xmin=sd.xmin
JOIN core.outbox o
 ON o.partition_no=n.partition_no AND o.epoch=n.epoch AND o.position=n.position AND o.event_seq=0
 AND o.xmin=n.xmin AND o.type='com.rezics.semantic.public-output.capture.v1'
JOIN core.partition p
 ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position
 AND p.write_state='active' AND p.moved_to IS NULL
WHERE c.route=$1 AND c.collection_id=$2 AND g.generation=$3
 AND c.membership_kind='dynamic' AND c.builtin_kind IN ('everything','state') AND g.state='complete'
 AND b.incarnation=c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text
 AND b.activation_source_generation=g.source_generation+1 AND c.source_generation>b.activation_source_generation
 AND t.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
 AND NOT EXISTS (
   SELECT 1 FROM library.collection_retained_output r
   WHERE r.route=c.route AND r.collection_id=c.collection_id AND r.generation=g.generation
 )
 AND NOT EXISTS (
   SELECT 1 FROM library.native_public_output_hold other
   WHERE other.route=g.route AND other.collection_id=g.collection_id AND other.output_generation=g.generation
     AND other.consumed_by IS NULL
 )
 AND NOT EXISTS (
   SELECT 1 FROM library.native_source_capture a
   WHERE a.route=g.route AND a.collection_id=g.collection_id AND a.scope='active_explicit_output'
     AND a.output_generation=g.generation
 )
 AND NOT EXISTS (
   SELECT 1 FROM library.identity_scope_plan i
   WHERE i.route=g.route AND i.collection_id=g.collection_id AND i.source_identity->>'scope'='active_explicit_output'
     AND i.source_identity->>'outputGeneration'=g.generation::text
 )
FOR UPDATE OF c,g;
