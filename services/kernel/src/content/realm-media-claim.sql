WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :uploader_id::uuid AS uploader_id,
         :media_id::uuid AS media_id, :purpose::text AS purpose, :at::timestamptz AS at
)
UPDATE content.media m
SET claimed_at = COALESCE(m.claimed_at, i.at), claimed_realm_id = i.realm_id
FROM input i
WHERE m.route = i.route AND m.media_id = i.media_id AND m.container_id = i.realm_id
  AND m.uploader_id = i.uploader_id AND m.purpose = i.purpose AND m.state = 'available'
  AND (m.claimed_realm_id IS NULL OR m.claimed_realm_id = i.realm_id)
  AND NOT m.erased AND NOT m.collection_pending AND NOT m.taken_down
RETURNING m.media_id;
