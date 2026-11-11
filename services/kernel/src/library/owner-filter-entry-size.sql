SELECT (COALESCE(pg_column_size(library_profile_pin), 0)::bigint + COALESCE(pg_column_size(state), 0))::text AS "projectionBytes",
       pg_column_compression(library_profile_pin) IS NOT NULL
         OR pg_column_compression(state) IS NOT NULL AS "projectionCompressed"
FROM (
  SELECT state, owner_write_seq, library_profile_pin
  FROM library.entry
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  UNION ALL
  SELECT NULL::text, owner_write_seq, NULL::jsonb
  FROM library.entry_clear
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
) facts
ORDER BY owner_write_seq DESC NULLS FIRST
LIMIT 1;
