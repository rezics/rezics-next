SELECT g.partition_no,g.terminal::text,g.generation::text,g.version::text,g.owner_epoch,
 g.published_epoch::text,p.epoch,p.write_state,p.moved_to
FROM semantic.identity_epoch_group g JOIN core.partition p ON p.partition_no=g.partition_no
WHERE g.partition_no=$1 AND g.terminal=$2 AND g.ready AND g.pending_job IS NULL
 AND g.owner_epoch=p.epoch AND p.write_state='active' AND p.moved_to IS NULL FOR UPDATE OF g,p;
