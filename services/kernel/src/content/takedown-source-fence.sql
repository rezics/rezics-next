-- All groups share the source record route. Only this complete tuple PK can
-- conflict; no source catalogue, subject mapping or history is consulted.
INSERT INTO content.source_fences AS fence
  (route, source, external_id, field_group, taken_down, security_revision)
VALUES (:route::integer, :source::text, :external_id::text, :field_group::text, true, 1)
ON CONFLICT (route, source, external_id, field_group) DO UPDATE
SET taken_down = true, security_revision = fence.security_revision + 1
RETURNING security_revision::text AS "securityRevision";
