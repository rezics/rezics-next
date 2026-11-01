-- All evidence here belongs to ONE source home. No foreign checkout is held.
SELECT a.position::text, a.owner_epoch, a.transaction_id::text, a.native_xid::text
FROM semantic.public_filter_repair_advance a
JOIN core.partition p ON p.partition_no = a.partition_no
JOIN semantic.subject s ON s.route = a.route AND s.subject_id = a.subject_id
WHERE a.partition_no = :partition_no::integer AND a.bootstrap = :bootstrap::uuid
  AND a.execution = :execution::text AND a.step = :step::uuid
  AND a.route = :route::integer AND a.subject_id = :subject_id::uuid
  AND a.transaction_id IS NOT NULL AND a.native_xid IS NOT NULL
  AND p.epoch = a.owner_epoch AND p.write_state = 'active'
  AND p.position = :source_position::bigint AND a.position <= p.position
  AND s.security_revision::text = :security_revision::text
  AND s.current_release = :current_release::text
  AND (SELECT revision FROM semantic.revision r
    WHERE r.route = s.route AND r.subject_id = s.subject_id
    ORDER BY revision DESC LIMIT 1) = :revision::integer
  AND COALESCE((SELECT target FROM semantic.redirect r
    WHERE r.route = s.route AND r.subject_id = s.subject_id
    ORDER BY sequence DESC LIMIT 1),s.subject_id) = :terminal::uuid;
