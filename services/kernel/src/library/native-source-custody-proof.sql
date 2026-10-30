SELECT r.transaction_id::text AS "transactionId",r.position::text AS position
FROM library.native_source_capture c JOIN library.native_source_receipt r
ON (r.route,r.capture_id)=(c.route,c.capture_id) AND r.xmin=c.xmin
JOIN core.partition p ON p.partition_no=(c.route >> 4) AND p.epoch=r.owner_epoch AND p.position>=r.position
WHERE c.route=:route AND c.capture_id=:capture_id AND c.complete
AND p.write_state='active' AND p.moved_to IS NULL
AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned();
