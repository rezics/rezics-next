-- Dispatched only after the two ordinary native readers admit these exact heads.
SELECT r.title AS "realmTitle", s.title AS "spaceTitle"
FROM community.realm_revision r
JOIN community.space_revision s ON s.route = r.route
  AND s.space_id = :space_id::uuid AND s.revision_id = :space_head::uuid
WHERE r.route = :route::integer AND r.realm_id = :realm_id::uuid
  AND r.revision_id = :realm_head::uuid;
