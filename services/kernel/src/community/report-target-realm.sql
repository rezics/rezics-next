-- A Realm and its host share a native route. Both lifecycle witnesses are retained.
WITH identity AS MATERIALIZED (
  SELECT realm_id, route, space_id, context_id, visibility, head_revision_id, lifecycle_version
  FROM community.realm WHERE route=:route::integer AND realm_id=:id::uuid AND state='active'
)
SELECT r.realm_id, r.space_id, r.context_id, r.visibility, r.head_revision_id, r.lifecycle_version::text,
       s.head_revision_id AS space_head, s.lifecycle_version::text AS space_version
FROM identity r JOIN community.space s ON s.route=r.route AND s.space_id=r.space_id AND s.state='active'
WHERE EXISTS (SELECT 1 FROM community.realm_revision h
              WHERE h.route=r.route AND h.realm_id=r.realm_id AND h.revision_id=r.head_revision_id)
  AND EXISTS (SELECT 1 FROM community.space_revision h
              WHERE h.route=s.route AND h.space_id=s.space_id AND h.revision_id=s.head_revision_id);
