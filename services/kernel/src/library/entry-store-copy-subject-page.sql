WITH args AS (
  SELECT :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :after_created_at::nullable(timestamptz) AS after_created_at,
         :after_copy_id::nullable(uuid) AS after_copy_id,
         :limit::integer AS page_limit
)
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
  CROSS JOIN args
WHERE copy.route = :route::integer
  AND copy.account_id = args.account_id
  AND copy.subject_id = args.subject_id
  AND (
    args.after_created_at IS NULL
    OR (copy.created_at, copy.copy_id) > (args.after_created_at, args.after_copy_id)
  )
ORDER BY copy.created_at, copy.copy_id
LIMIT (SELECT page_limit FROM args);
