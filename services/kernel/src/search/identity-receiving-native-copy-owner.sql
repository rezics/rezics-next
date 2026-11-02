SELECT p.epoch,p.position::text,g.consumer,g.incarnation,g.write_alias,
 w.closed_job::text,w.closed_epoch::text,w.closed_transaction_id::text,w.closed_position::text,
 w.writer_token::text,w.writer_transaction_id::text,w.writer_position::text,w.dispatch_state,
 w.settled_transaction_id::text,w.settled_position::text,w.visible_transaction_id::text,w.visible_position::text,
 (c.transaction_id IS NOT NULL) AS close_proven
FROM core.partition p
JOIN search.identity_writer_gate g ON g.partition_no=p.partition_no AND g.physical_target=$2 AND g.owner_epoch=p.epoch
JOIN search.identity_writer w ON (w.partition_no,w.physical_target,w.incarnation,w.owner_epoch)=
 (g.partition_no,g.physical_target,g.incarnation,p.epoch) AND w.original_id=$3
LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
 (w.partition_no,w.closed_transaction_id,p.epoch,w.closed_position) AND c.purpose='search-canonical-index'
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
WHERE p.partition_no=$1 AND p.write_state='active';
