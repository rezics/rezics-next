SELECT s.subject_id::text AS subject, m.owner_epoch, m.terminal::text AS terminal,
       m.closure_state, m.control_partition, g.owner_epoch AS group_owner_epoch,
       g.pending_job::text AS pending_job, g.pending_epoch::text AS pending_epoch
FROM semantic.subject s
LEFT JOIN LATERAL (
  SELECT owner_epoch, terminal, closure_state, control_partition, control_group
  FROM semantic.identity_epoch_mapping
  WHERE route = :route::integer AND original = s.subject_id
  LIMIT 1
) m ON true
LEFT JOIN LATERAL (
  SELECT owner_epoch, pending_job, pending_epoch FROM semantic.identity_epoch_group
  WHERE partition_no = (:route::integer / 16) AND partition_no = m.control_partition
    AND terminal = m.control_group
  LIMIT 1
) g ON true
WHERE s.route = :route::integer AND s.subject_id = :subject_id::uuid
FOR UPDATE OF s;
