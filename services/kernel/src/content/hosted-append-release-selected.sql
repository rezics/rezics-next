-- Exact selected IDs only: the immutable descriptor fences every stream hit.
-- The stream/occurrence unique key bounds rows by the unchanged release cap.
SELECT a.append_offset::text AS append_offset,a.occurrence_id,a.title,
       o.thread_id,o.post_id,a.target_revision_id,encode(a.body_sha256,'hex') AS sha256
FROM content.hosted_append a
JOIN content.hosted_occurrence o USING (route,catalogue_id,occurrence_id)
WHERE a.route=:route::integer AND a.catalogue_id=:catalogue_id::uuid
  AND a.stream_id=:stream_id::uuid AND a.occurrence_id=ANY(:occurrence_ids::uuid[])
  AND a.append_offset<=:high_water::bigint
ORDER BY a.append_offset ASC;
