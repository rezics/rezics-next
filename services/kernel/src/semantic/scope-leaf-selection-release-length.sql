-- Read only named immutable release properties, never unrelated definitions.
WITH stored AS MATERIALIZED (
  SELECT body FROM semantic.definition_release WHERE route = 0 AND digest = :digest::text
), picked AS MATERIALIZED (
  SELECT p.properties FROM stored
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_object_agg(w.name, stored.body->'properties'->w.name)
      FILTER (WHERE stored.body->'properties'->w.name IS NOT NULL), '{}'::jsonb) AS properties
    FROM unnest(:properties::text[]) AS w(name)
  ) p
)
SELECT octet_length(properties::text) AS bytes FROM picked;
