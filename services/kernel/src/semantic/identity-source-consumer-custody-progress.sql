SELECT r.sequence::text,r.state,r.directory_after,r.ticket_key,r.effect_after,r.seal_digest,
       r.replay_generation::text,r.undo_generation::text,r.restore_generation::text,
       r.transaction_id,r.owner_epoch,n.position::text,
       r.receiving_partition,r.receiving_epoch,r.receiving_position::text,r.receiving_transaction_id,
       (n.transaction_id IS NOT NULL AND p.partition_no IS NOT NULL) AS native_current
FROM (
 SELECT *, xmin AS source_xmin FROM semantic.identity_epoch_source_consumer_terminal
 WHERE partition_no=$1 AND custody_key=$2 ORDER BY sequence DESC LIMIT 1
) r
LEFT JOIN semantic.erasure_source_commit n ON n.partition_no=r.partition_no AND n.transaction_id=r.transaction_id
 AND n.epoch=r.owner_epoch AND n.xmin=r.source_xmin
LEFT JOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'
 AND p.moved_to IS NULL AND p.epoch=r.owner_epoch AND p.position>=n.position;
