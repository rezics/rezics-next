SELECT (COALESCE(pg_column_size(library_profile_pin), 0)::bigint
         + COALESCE(pg_column_size(kind), 0) + pg_column_size(status))::text AS "projectionBytes",
       pg_column_compression(library_profile_pin) IS NOT NULL
         OR pg_column_compression(kind) IS NOT NULL OR pg_column_compression(status) IS NOT NULL AS "projectionCompressed"
FROM library.copy
WHERE route = :route AND account_id = :account_id
  AND subject_id = :subject_id AND copy_id = :copy_id AND deletion_id IS NULL;
