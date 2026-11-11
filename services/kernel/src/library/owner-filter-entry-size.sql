WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id
), facts AS (
  SELECT entry.state, entry.owner_write_seq, entry.library_profile_pin
  FROM library.entry AS entry
  CROSS JOIN input
  WHERE entry.route = input.route
    AND entry.account_id = input.account_id
    AND entry.subject_id = input.subject_id
  UNION ALL
  SELECT NULL::text, clear.owner_write_seq, NULL::jsonb
  FROM library.entry_clear AS clear
  CROSS JOIN input
  WHERE clear.route = input.route
    AND clear.account_id = input.account_id
    AND clear.subject_id = input.subject_id
)
SELECT (COALESCE(pg_column_size(library_profile_pin), 0)::bigint + COALESCE(pg_column_size(state), 0))::text AS "projectionBytes",
       pg_column_compression(library_profile_pin) IS NOT NULL
         OR pg_column_compression(state) IS NOT NULL AS "projectionCompressed"
FROM facts
ORDER BY owner_write_seq DESC NULLS FIRST
LIMIT 1;
