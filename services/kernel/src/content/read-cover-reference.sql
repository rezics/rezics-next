-- A reference fact only: current subject authorization and source fences belong to the caller.
SELECT media_id AS "mediaId", container_id AS "containerId", sha256,
       source_url AS "sourceUrl", credit, provenance
FROM content.media
WHERE route = :route::integer AND media_id = ANY (ARRAY[:media_id::uuid])
  AND purpose = 'cover' AND state = 'available'
  AND NOT erased AND NOT collection_pending AND NOT taken_down
  AND actual_byte_count IS NOT NULL AND media_type IS NOT NULL AND sha256 IS NOT NULL;
