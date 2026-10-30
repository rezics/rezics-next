WITH input AS (SELECT :time::timestamptz AS time)
UPDATE library.copy
SET deletion_id = :deletion_id::uuid, deleted_at = input.time,
    restore_until = input.time + interval '720 hours', revision = revision + 1
FROM input
WHERE route = :route::integer AND copy_id = :copy_id::uuid AND revision = :revision::integer
  AND deletion_id IS NULL AND revision <= 2147483644
RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
          acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId";
