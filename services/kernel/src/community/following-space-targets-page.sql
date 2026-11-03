WITH wanted AS MATERIALIZED (
  SELECT route, id
  FROM unnest(:routes::integer[], :ids::uuid[]) AS input(route, id)
), spaces AS MATERIALIZED (
  SELECT h.route, h.space_id, h.head_revision_id AS space_head_revision_id,
         h.lifecycle_version::text AS space_lifecycle_version,
         revision.address, revision.title
  FROM wanted input
  JOIN community.space h ON h.route = input.route AND h.space_id = input.id
  JOIN community.space_revision revision
    ON revision.route = h.route
   AND revision.space_id = h.space_id
   AND revision.revision_id = h.head_revision_id
  WHERE h.state = 'active'
    AND h.created_at <= :at::timestamptz
    AND revision.created_at <= :at::timestamptz
), realms AS MATERIALIZED (
  SELECT space.route, space.space_id, realm.realm_id,
         realm.head_revision_id AS realm_head_revision_id,
         realm.lifecycle_version::text AS realm_lifecycle_version
  FROM spaces space
  JOIN LATERAL (
    SELECT h.realm_id, h.head_revision_id, h.lifecycle_version
    FROM community.realm h
    JOIN community.realm_revision revision
      ON revision.route = h.route
     AND revision.realm_id = h.realm_id
     AND revision.revision_id = h.head_revision_id
    WHERE h.route = space.route
      AND h.space_id = space.space_id
      AND h.state = 'active'
      AND h.created_at <= :at::timestamptz
      AND revision.created_at <= :at::timestamptz
    ORDER BY h.route, h.realm_id
    LIMIT 1
  ) realm ON true
)
SELECT space.space_id, space.space_head_revision_id, space.space_lifecycle_version,
       space.address, space.title,
       realm.realm_id, realm.realm_head_revision_id, realm.realm_lifecycle_version
FROM spaces space
LEFT JOIN realms realm ON realm.route = space.route AND realm.space_id = space.space_id;
