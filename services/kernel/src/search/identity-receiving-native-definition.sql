-- The admitted immutable definition supplies meaning. Do not register a new Source or read an
-- unbounded capture body merely to resolve the exact definition named by a retained plan.
SELECT d.release_digest,d.subject_type,s.route_digest
FROM semantic.public_filter_read_definition d
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=
 (d.partition_no,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=s.partition_no AND p.epoch=s.owner_epoch
 AND p.write_state='active'
WHERE d.partition_no=0 AND d.read_definition=$1;
