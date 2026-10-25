-- UPDATE holds native row locks until the referencing command commits or rolls back.
-- The helper rejects a partial result, rolling back every claim with the failed command.
UPDATE content.media AS media
SET claimed_at = COALESCE(media.claimed_at, :at::timestamptz)
WHERE media.route = :route::integer AND media.media_id = ANY (:media_ids::uuid[])
  AND media.uploader_id = :uploader_id::uuid AND media.container_id = :container_id::uuid
  AND media.purpose = 'cover' AND media.state = 'available'
  AND NOT media.erased AND NOT media.collection_pending AND NOT media.taken_down
  AND media.actual_byte_count IS NOT NULL AND media.media_type IS NOT NULL AND media.sha256 IS NOT NULL
RETURNING media.media_id AS "mediaId", media.container_id AS "containerId", media.sha256,
          media.source_url AS "sourceUrl", media.credit, media.provenance;
