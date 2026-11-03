SELECT (COALESCE(pg_column_size(library_profile_pin), 0)::bigint
         + pg_column_size(state) + pg_column_size(mode) + pg_column_size(unit))::text AS "projectionBytes",
       pg_column_compression(library_profile_pin) IS NOT NULL
         OR pg_column_compression(state) IS NOT NULL OR pg_column_compression(mode) IS NOT NULL
         OR pg_column_compression(unit) IS NOT NULL AS "projectionCompressed"
FROM library.progress_session
WHERE state <> 'retired' AND route = :route AND account_id = :account_id
  AND subject_id = :subject_id AND session_id = :session_id;
