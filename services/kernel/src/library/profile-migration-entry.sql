WITH source AS MATERIALIZED (
  SELECT subject_id
  FROM library.entry
  WHERE route = :route::integer AND account_id = :account_id::uuid
    AND subject_id > :after_id::uuid AND library_profile_pin IS NULL
  ORDER BY subject_id
  LIMIT :page_limit::integer
  FOR UPDATE
), changed AS (
  UPDATE library.entry AS fact
  SET library_profile_pin = :pin::jsonb
  FROM source
  WHERE fact.route = :route AND fact.account_id = :account_id
    AND fact.subject_id = source.subject_id AND fact.library_profile_pin IS NULL
  RETURNING fact.subject_id
)
SELECT source.subject_id::text AS id, changed.subject_id IS NOT NULL AS changed, false AS incompatible
FROM source LEFT JOIN changed USING (subject_id)
ORDER BY source.subject_id;
