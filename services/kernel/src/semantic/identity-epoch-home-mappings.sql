-- One home per statement. Only source controls owned by this home enter the physical lookup.
WITH input AS (SELECT $1::integer AS home, $2::uuid[] AS originals, $3::integer[] AS routes),
source AS MATERIALIZED (
  SELECT s.subject_id, (s.mapping).*, s.dirty_revision, s.captured_revision, s.current_target
  FROM input, LATERAL semantic.identity_epoch_mapping_sources(originals, routes) s
), local_keys AS MATERIALIZED (
  SELECT array_agg(s.control_partition ORDER BY s.subject_id) AS homes,
         array_agg(s.control_group ORDER BY s.subject_id) AS groups,
         array_agg(s.original ORDER BY s.subject_id) AS originals
  FROM source s, input WHERE s.control_partition=input.home AND s.control_group IS NOT NULL AND s.original IS NOT NULL
), points AS MATERIALIZED (
  SELECT g.requested_original,
         to_jsonb(g) || jsonb_build_object('published_epoch', g.published_epoch::text,
           'directory_revision',g.directory_revision::text,'pending_epoch',g.pending_epoch::text) AS current
  FROM local_keys k, LATERAL semantic.identity_epoch_group_points(k.homes,k.groups,k.originals) g
)
SELECT p.partition_no AS native_home, p.epoch AS native_epoch, p.write_state AS native_state,
       p.position AS native_position, s.*, points.current AS native_current
FROM input LEFT JOIN core.partition p ON p.partition_no=input.home
LEFT JOIN source s ON true LEFT JOIN points ON points.requested_original=s.original
ORDER BY s.subject_id;
