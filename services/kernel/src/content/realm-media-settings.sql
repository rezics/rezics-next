-- The exact native head must have been appended and moved by this settings transaction.
SELECT h.realm_id
FROM community.realm h
JOIN community.realm_revision r
  ON r.route = :route::integer AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
WHERE h.route = :route::integer AND h.realm_id = :realm_id::uuid AND h.state = 'active'
  AND h.xmin::text = pg_current_xact_id_if_assigned()::text
  AND r.xmin::text = pg_current_xact_id_if_assigned()::text
  AND r.predecessor IS NOT NULL AND r.author = :author_id::uuid
LIMIT 1;
