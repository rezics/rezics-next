SELECT g.consumer,g.incarnation,g.owner_epoch,g.write_alias,
 g.enrollment_generation::text,g.fence_generation::text,g.closed_token::text,
 w.writer_token::text,w.writer_transaction_id::text,w.writer_position::text,w.dispatch_state,
 w.closed_job::text,w.closed_epoch::text,w.closed_transaction_id::text,w.closed_position::text,
 w.settled_transaction_id::text,w.settled_position::text,w.visible_transaction_id::text,
 w.visible_position::text,w.source_position::text,
 (w.xmin=pg_current_xact_id_if_assigned()::xid) AS changed_in_command
FROM search.identity_writer_gate g
JOIN search.identity_writer w ON (w.partition_no,w.physical_target)=(g.partition_no,g.physical_target)
 AND w.original_id=$3 AND w.incarnation=g.incarnation AND w.owner_epoch=g.owner_epoch
WHERE g.partition_no=$1 AND g.physical_target=$2
FOR UPDATE OF g,w;
