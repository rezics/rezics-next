-- Include legacy structures and publications, not just append descriptors.
-- Only a self-base descriptor captures its stream's terminal bound. Every other
-- descriptor retains its immutable watermark but does not start another stream.
SELECT r.revision_id,r.kind,r.source_revision_id,d.base_revision_id,
       d.base_placement_count::text,d.base_root_count::text,d.high_water::text,
       CASE WHEN d.revision_id=d.base_revision_id THEN COALESCE(s.append_offset,-1)::text END AS stream_high_water
FROM (
  SELECT revision_id,kind,source_revision_id
  FROM content.hosted_structure_revision
  WHERE route=:route::integer AND catalogue_id=:catalogue_id::uuid
    AND (:after_revision::uuid IS NULL OR revision_id>:after_revision::uuid)
  ORDER BY revision_id
  LIMIT 100
) r
LEFT JOIN content.hosted_append_descriptor d
  ON d.route=:route::integer AND d.catalogue_id=:catalogue_id::uuid AND d.revision_id=r.revision_id
LEFT JOIN LATERAL (
  SELECT a.append_offset FROM content.hosted_append a
  WHERE a.route=:route::integer AND a.catalogue_id=:catalogue_id::uuid
    AND a.stream_id=d.revision_id AND d.revision_id=d.base_revision_id
  ORDER BY a.append_offset DESC LIMIT 1
) s ON true
ORDER BY r.revision_id;
