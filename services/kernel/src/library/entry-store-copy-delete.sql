DELETE FROM library.copy
WHERE route = :route AND copy_id = :copy_id AND revision = :revision
RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
          acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
          created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId";
