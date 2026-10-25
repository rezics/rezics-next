-- At most 100 exact keys, all in the caller's independently anchored partition.
-- The lateral bound keeps each probe on the complete primary key, even amid
-- many records sharing the same source and partition. No catalogue lookup.
SELECT requested.route, requested.source, requested.external_id, requested.field_group,
       fence.taken_down AS "takenDown", fence.security_revision::text AS "securityRevision"
FROM jsonb_to_recordset(:tuples::jsonb) AS requested(
  route integer, source text, external_id text, field_group text
)
CROSS JOIN LATERAL (
  SELECT taken_down, security_revision
  FROM content.source_fences AS stored
  WHERE stored.route = requested.route AND stored.source = requested.source COLLATE "C"
    AND stored.external_id = requested.external_id COLLATE "C"
    AND stored.field_group = requested.field_group COLLATE "C"
  LIMIT 1
) AS fence;
