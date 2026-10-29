SELECT copy.route,
       copy.copy_id AS id,
       copy.account_id AS "accountId",
       copy.subject_id AS "subjectId",
       copy.kind,
       copy.status,
       copy.location,
       copy.source,
       copy.acquired_on::text AS "acquiredOn",
       copy.disposed_on::text AS "disposedOn",
       copy.note,
       copy.revision,
       copy.created_at::text AS "createdAt",
       copy.updated_at::text AS "updatedAt",
       copy.transaction_id AS "transactionId"
FROM library.copy AS copy
WHERE copy.route = :route::integer
  AND copy.account_id = :account_id::uuid
  AND copy.subject_id = :subject_id::uuid
  AND (copy.created_at, copy.copy_id) > (
    COALESCE(:after_created_at::nullable(timestamptz), '-infinity'::timestamptz),
    COALESCE(:after_copy_id::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid)
  )
ORDER BY copy.created_at, copy.copy_id
LIMIT :limit::integer;
