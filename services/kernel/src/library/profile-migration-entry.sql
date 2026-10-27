WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), source AS MATERIALIZED (
  SELECT subject_id
  FROM library.entry
  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
    AND subject_id > :after_id::uuid AND library_profile_pin IS NULL
  ORDER BY subject_id
  LIMIT :page_limit::integer
  FOR UPDATE
), changed AS (
  UPDATE library.entry AS fact
  SET library_profile_pin = :pin::jsonb
  FROM source
  WHERE fact.route = (SELECT route FROM input) AND fact.account_id = (SELECT account_id FROM input)
    AND fact.subject_id = source.subject_id AND fact.library_profile_pin IS NULL
  RETURNING fact.subject_id
)
SELECT source.subject_id::text AS id, changed.subject_id IS NOT NULL AS changed, false AS incompatible
FROM source LEFT JOIN changed USING (subject_id)
ORDER BY source.subject_id;
