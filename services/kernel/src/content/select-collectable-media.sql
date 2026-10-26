-- Each branch is independently bounded before the host merges sixteen exact routes.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
(SELECT media.route, media_id::text AS "mediaId", container_id::text AS "containerId",
        uploader_id::text AS "uploaderId", created_at::text AS "createdAt"
 FROM content.media AS media CROSS JOIN input
 WHERE media.route = input.route
   AND claimed_at IS NULL AND NOT erased AND NOT collection_pending
   AND created_at <= :at::timestamptz - interval '24 hours'
 ORDER BY created_at, media_id
 LIMIT :batch::integer)
UNION ALL
(SELECT media.route, media_id::text AS "mediaId", container_id::text AS "containerId",
        uploader_id::text AS "uploaderId", created_at::text AS "createdAt"
 FROM content.media AS media CROSS JOIN input
 WHERE media.route = input.route AND collection_pending
   AND claimed_at IS NULL AND NOT erased
 ORDER BY created_at, media_id
 LIMIT :pending_batch::integer);
