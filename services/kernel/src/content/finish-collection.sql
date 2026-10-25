-- Variant metadata cascades only after the complete remote prefix was deleted.
DELETE FROM content.media
WHERE route = :route::integer AND media_id = :media_id::uuid
  AND collection_pending AND claimed_at IS NULL AND NOT erased
RETURNING media_id::text AS "mediaId", container_id::text AS "containerId";
