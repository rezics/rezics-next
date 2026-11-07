-- Current Space/Realm heads compared with the stored witness. Keys are a JSON array
-- bound as text so the reader never treats the list as a PostgreSQL array.
WITH requested AS MATERIALIZED (
  SELECT k.route, k.id FROM jsonb_to_recordset((:keys::text)::jsonb) AS k(route integer, id uuid)
)
SELECT s.route, s.space_id, s.head_revision_id::text AS current_space_revision,
       r.realm_id::text AS current_realm_id, r.head_revision_id::text AS current_realm_revision,
       w.witness_generation::text, w.space_revision::text, w.realm_id::text, w.realm_revision::text,
       w.producer_generation, w.producer_epoch::text, w.source_position::text, w.tuple_count, w.state
FROM requested k
JOIN community.space s ON s.route = k.route AND s.space_id = k.id
JOIN community.space_revision sv
  ON sv.route = s.route AND sv.space_id = s.space_id AND sv.revision_id = s.head_revision_id
LEFT JOIN community.realm r ON r.route = s.route AND r.space_id = s.space_id
LEFT JOIN community.realm_revision hv
  ON hv.route = r.route AND hv.realm_id = r.realm_id AND hv.revision_id = r.head_revision_id
LEFT JOIN community.space_discovery_tuple_witness w ON w.route = s.route AND w.space_id = s.space_id
WHERE r.realm_id IS NULL OR hv.revision_id IS NOT NULL;
