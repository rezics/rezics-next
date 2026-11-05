-- Exact current head and lifecycle; no revision history or metadata body is loaded.
SELECT s.space_id, s.head_revision_id, s.lifecycle_version::text
FROM community.space s
WHERE s.route = :route::integer AND s.space_id = :id::uuid AND s.state = 'active'
  AND EXISTS (SELECT 1 FROM community.space_revision h
              WHERE h.route=s.route AND h.space_id=s.space_id AND h.revision_id=s.head_revision_id);
