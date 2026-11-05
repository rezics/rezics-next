WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS home
), raw AS MATERIALIZED (
  SELECT s.route, s.subject_id, s.visibility
  FROM semantic.subject s CROSS JOIN input
  WHERE s.route >= input.home * 16 AND s.route < (input.home + 1) * 16
    AND (s.route, s.subject_id) > (:after_route::integer, :after_id::uuid)
  ORDER BY s.route, s.subject_id
  LIMIT :input_limit::integer
)
SELECT raw.route, raw.subject_id::text AS id, raw.visibility, redirect.target::text AS redirect,
  coalesce(mapping.terminal = raw.subject_id AND mapping.epoch > 0
    AND mapping.control_partition = input.home AND mapping.control_group = raw.subject_id
    AND mapping.owner_epoch = owner.epoch
    AND coalesce(dirty.revision, 0) <= coalesce(dirty.captured_revision, 0)
    AND identity_group.owner_epoch = owner.epoch AND identity_group.published_epoch > 0
    AND coalesce((to_jsonb(identity_group)->>'ready')::boolean, false)
    AND identity_group.pending_job IS NULL, false) AS identity_ready
FROM raw CROSS JOIN input
JOIN core.partition owner ON owner.partition_no = input.home
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  WHERE route = raw.route AND subject_id = raw.subject_id
  ORDER BY sequence DESC LIMIT 1
) redirect ON true
LEFT JOIN LATERAL (
  SELECT terminal, epoch, control_partition, control_group, owner_epoch
  FROM semantic.identity_epoch_mapping
  WHERE (route, original) = (raw.route, raw.subject_id) LIMIT 1
) mapping ON true
LEFT JOIN LATERAL (
  SELECT revision, captured_revision FROM semantic.identity_epoch_dirty
  WHERE (route, original) = (raw.route, raw.subject_id) LIMIT 1
) dirty ON true
-- Only unredirected native originals can be candidates, so their terminal control home is local.
-- No foreign control group is read, even when a stale/mutated mapping names one.
LEFT JOIN LATERAL (
  SELECT owner_epoch, published_epoch, pending_job, ready FROM semantic.identity_epoch_group
  WHERE (partition_no, terminal) = (input.home, raw.subject_id) LIMIT 1
) identity_group ON true
ORDER BY raw.route, raw.subject_id;
