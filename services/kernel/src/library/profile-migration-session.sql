WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), source AS MATERIALIZED (
  SELECT session_id
  FROM library.progress_session
  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
    AND session_id > :after_id::uuid AND library_profile_pin IS NULL
  ORDER BY session_id
  LIMIT :page_limit::integer
  FOR UPDATE
), changed AS (
  UPDATE library.progress_session AS fact
  SET library_profile_pin = :pin::jsonb
  FROM source
  WHERE fact.route = (SELECT route FROM input) AND fact.account_id = (SELECT account_id FROM input)
    AND fact.session_id = source.session_id AND fact.library_profile_pin IS NULL
  RETURNING fact.session_id
)
SELECT source.session_id::text AS id, changed.session_id IS NOT NULL AS changed, false AS incompatible
FROM source LEFT JOIN changed USING (session_id)
ORDER BY source.session_id;
