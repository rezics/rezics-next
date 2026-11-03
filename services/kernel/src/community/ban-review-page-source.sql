-- Lifecycle observations only. Moderation does not admit either title.
SELECT r.space_id::text AS "spaceId", r.head_revision_id::text AS "realmHead",
       r.lifecycle_version::text AS "realmVersion", r.discovery_epoch::text AS "sourceEpoch",
       s.head_revision_id::text AS "spaceHead", s.lifecycle_version::text AS "spaceVersion"
FROM community.realm r
JOIN community.space s ON s.route = r.route AND s.space_id = r.space_id
WHERE r.route = :route::integer AND r.realm_id = :realm_id::uuid
  AND r.state = 'active' AND s.state = 'active'
  AND r.created_at <= :at::timestamptz AND s.created_at <= :at::timestamptz;
