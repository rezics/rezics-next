-- UPDATE takes the same media row lock used by claims and image publication.
-- A selection is only a hint: recheck age and claims at this command's trusted T.
UPDATE content.media
SET collection_pending = true, transaction_id = :transaction_id::uuid
WHERE route = :route::integer AND media_id = :media_id::uuid
  AND claimed_at IS NULL AND NOT erased
  AND (collection_pending OR created_at <= :at::timestamptz - interval '24 hours')
RETURNING media_id::text AS "mediaId", container_id::text AS "containerId";
