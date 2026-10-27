WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), source AS MATERIALIZED (
  SELECT copy_id, kind
  FROM library.copy
  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
    AND copy_id > :after_id::uuid AND library_profile_pin IS NULL
  ORDER BY copy_id
  LIMIT :page_limit::integer
  FOR UPDATE
), incompatible AS MATERIALIZED (
  SELECT 1 FROM source WHERE kind IS NOT NULL AND kind <> 'legacy-unspecified'
), changed AS (
  UPDATE library.copy AS fact
  SET library_profile_pin = :pin::jsonb, kind = COALESCE(fact.kind, 'legacy-unspecified')
  FROM source
  WHERE fact.route = (SELECT route FROM input) AND fact.account_id = (SELECT account_id FROM input)
    AND fact.copy_id = source.copy_id AND fact.library_profile_pin IS NULL
    AND NOT EXISTS (SELECT 1 FROM incompatible)
  RETURNING fact.copy_id
)
SELECT source.copy_id::text AS id, changed.copy_id IS NOT NULL AS changed,
       EXISTS (SELECT 1 FROM incompatible) AS incompatible
FROM source LEFT JOIN changed USING (copy_id)
ORDER BY source.copy_id;
