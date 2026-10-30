-- Check exact native authorship before reading association metadata or mutating.
SELECT id
FROM content.authored_field
WHERE route = :route::integer AND id = ANY (ARRAY[:id::uuid])
  AND author_account_id = :author_id::uuid;
