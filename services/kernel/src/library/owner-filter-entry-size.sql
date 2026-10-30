SELECT (COALESCE(pg_column_size(library_profile_pin), 0)::bigint + pg_column_size(state))::text AS "projectionBytes",
       pg_column_compression(library_profile_pin) IS NOT NULL
         OR pg_column_compression(state) IS NOT NULL AS "projectionCompressed"
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id;
