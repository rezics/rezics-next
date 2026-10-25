-- Each branch is independently bounded before the host merges sixteen exact routes.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :at::timestamptz AS at, :batch::integer AS batch
)
(SELECT route, media_id::text AS "mediaId", container_id::text AS "containerId",
        uploader_id::text AS "uploaderId", created_at::text AS "createdAt"
 FROM content.media
 WHERE route = (SELECT route FROM input)
   AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
   AND created_at <= (SELECT at FROM input) - interval '24 hours'
 ORDER BY created_at, media_id
 LIMIT (SELECT batch FROM input))
UNION ALL
(SELECT route, media_id::text AS "mediaId", container_id::text AS "containerId",
        uploader_id::text AS "uploaderId", created_at::text AS "createdAt"
 FROM content.media
 WHERE route = (SELECT route FROM input) AND collection_pending
   AND claimed_at IS NULL AND NOT erased
 ORDER BY created_at, media_id
 LIMIT (SELECT batch FROM input));
