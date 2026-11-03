-- Lifecycle observations only. Moderation does not admit either title.
WITH input AS (SELECT :at::timestamptz AS at)
SELECT r.space_id::text AS "spaceId", r.head_revision_id::text AS "realmHead",
       r.lifecycle_version::text AS "realmVersion", r.discovery_epoch::text AS "sourceEpoch",
       s.head_revision_id::text AS "spaceHead", s.lifecycle_version::text AS "spaceVersion"
FROM input, community.realm r
JOIN community.space s ON s.route = r.route AND s.space_id = r.space_id
WHERE r.route = :route::integer AND r.realm_id = :realm_id::uuid
  AND r.state = 'active' AND s.state = 'active'
  AND r.created_at <= input.at AND s.created_at <= input.at;
