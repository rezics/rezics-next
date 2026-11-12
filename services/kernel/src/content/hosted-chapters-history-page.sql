-- The tuple predicate is an index seek even on late pages. No OFFSET, optional
-- boundary filter, placement join, body read or full-history aggregate belongs here.
SELECT r.revision_id, r.kind, r.source_revision_id,
       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.hosted_structure_revision r
WHERE r.route = :route::integer AND r.catalogue_id = :catalogue_id::uuid
  AND (r.created_at, r.revision_id) < (:before_created_at::timestamptz, :before_revision_id::uuid)
ORDER BY r.created_at DESC, r.revision_id DESC
LIMIT :limit::integer;
