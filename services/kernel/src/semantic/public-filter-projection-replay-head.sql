SELECT e.owner_epoch, e.position::text, p.epoch, p.write_state,
       h.position::text AS current_position
FROM semantic.public_filter_projection_head e
JOIN core.partition p ON p.partition_no=e.partition_no
JOIN semantic.public_filter_privacy_head h ON h.partition_no=e.partition_no
WHERE e.build_id=:build_id::uuid AND e.partition_no=:partition_no::integer;
