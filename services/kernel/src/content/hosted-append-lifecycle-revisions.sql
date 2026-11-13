-- Include legacy structures and publications, not just append descriptors.
-- Only a self-base descriptor captures its stream's terminal bound. Every other
-- descriptor retains its immutable watermark but does not start another stream.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :catalogue_id::uuid AS catalogue_id,
         :after_revision::uuid AS after_revision
)
SELECT r.revision_id,r.kind,r.source_revision_id,d.base_revision_id,
       d.base_placement_count::text,d.base_root_count::text,d.high_water::text,
       CASE WHEN d.revision_id=d.base_revision_id THEN COALESCE(s.append_offset,-1)::text END AS stream_high_water
FROM input i
CROSS JOIN LATERAL (
  SELECT revision_id,kind,source_revision_id
  FROM content.hosted_structure_revision
  WHERE route=i.route AND catalogue_id=i.catalogue_id
    AND (i.after_revision IS NULL OR revision_id>i.after_revision)
  ORDER BY revision_id
  LIMIT 100
) r
LEFT JOIN content.hosted_append_descriptor d
  ON d.route=i.route AND d.catalogue_id=i.catalogue_id AND d.revision_id=r.revision_id
LEFT JOIN LATERAL (
  SELECT a.append_offset FROM content.hosted_append a
  WHERE a.route=i.route AND a.catalogue_id=i.catalogue_id
    AND a.stream_id=d.revision_id AND d.revision_id=d.base_revision_id
  ORDER BY a.append_offset DESC LIMIT 1
) s ON true
ORDER BY r.revision_id;
