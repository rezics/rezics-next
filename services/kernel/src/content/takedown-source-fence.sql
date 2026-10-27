-- All groups share the source record route. Only this complete tuple PK can
-- conflict; no source catalogue, subject mapping or history is consulted.
INSERT INTO content.source_fences AS fence
  (route, source, external_id, field_group, taken_down, security_revision, taken_down_at, takedown_id)
VALUES (:route::integer, :source::text, :external_id::text, :field_group::text, true, 1,
  :taken_down_at::timestamptz, :takedown_id::uuid)
ON CONFLICT (route, source, external_id, field_group) DO UPDATE
SET taken_down = true, security_revision = fence.security_revision + 1,
  taken_down_at = CASE WHEN fence.taken_down THEN fence.taken_down_at ELSE EXCLUDED.taken_down_at END,
  takedown_id = CASE WHEN fence.taken_down THEN fence.takedown_id ELSE EXCLUDED.takedown_id END
RETURNING security_revision::text AS "securityRevision",
  taken_down_at::text AS "takenDownAt", takedown_id AS "takedownId";
