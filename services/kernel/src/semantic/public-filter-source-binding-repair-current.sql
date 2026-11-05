-- All evidence here belongs to ONE source home. No foreign checkout is held.
WITH input AS (SELECT :source_position::bigint AS source_position)
SELECT a.position::text, a.owner_epoch, a.transaction_id::text, a.native_xid::text
FROM semantic.public_filter_repair_advance a
JOIN core.partition p ON p.partition_no = a.partition_no
JOIN semantic.subject s ON s.route = a.route AND s.subject_id = a.subject_id
CROSS JOIN input
WHERE a.partition_no = :partition_no::integer AND a.bootstrap = :bootstrap::uuid
  AND a.execution = :execution::text AND a.step = :step::uuid
  AND a.route = :route::integer AND a.subject_id = :subject_id::uuid
  AND a.transaction_id IS NOT NULL AND a.native_xid IS NOT NULL
  AND p.epoch = a.owner_epoch AND p.write_state = 'active'
  -- Projection writers advance core.position without changing these Subject
  -- fences. Its original Source advancement and exact current data/dependency
  -- checks remain mandatory; unrelated native commands cannot undo that repair.
  AND p.position >= input.source_position AND a.position <= input.source_position
  AND s.security_revision::text = :security_revision::text
  AND s.current_release = :current_release::text
  AND (SELECT revision FROM semantic.revision r
    WHERE r.route = s.route AND r.subject_id = s.subject_id
    ORDER BY revision DESC LIMIT 1) = :revision::integer
  AND COALESCE((SELECT target FROM semantic.redirect r
    WHERE r.route = s.route AND r.subject_id = s.subject_id
    ORDER BY sequence DESC LIMIT 1),s.subject_id) = :terminal::uuid;
