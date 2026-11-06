-- Bounded reference and expected tuples for the requested Spaces. Keys are a JSON array.
WITH requested AS MATERIALIZED (
  SELECT k.route, k.id FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
)
SELECT k.id AS space_id, d.tuple_route AS route, d.source, d.external_id, d.field_group,
       d.witness_generation::text, 'reference'::text AS kind
FROM requested k
JOIN LATERAL (
  SELECT * FROM community.space_discovery_tuple_reference d
  WHERE d.route = k.route AND d.space_id = k.id
  ORDER BY d.tuple_route, d.source, d.external_id, d.field_group
  LIMIT 51
) d ON true
UNION ALL
SELECT k.id AS space_id, d.tuple_route AS route, d.source, d.external_id, d.field_group,
       d.witness_generation::text, 'expected'::text AS kind
FROM requested k
JOIN community.space_discovery_tuple_witness w ON w.route = k.route AND w.space_id = k.id
JOIN LATERAL (
  SELECT * FROM community.space_discovery_tuple_expected d
  WHERE d.route = k.route AND d.space_id = k.id AND d.witness_generation = w.witness_generation
  ORDER BY d.tuple_route, d.source, d.external_id, d.field_group
  LIMIT 51
) d ON true;
