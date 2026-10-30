SELECT copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status,
       location, source, acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
       library_profile_pin AS "libraryProfilePin", deletion_id AS "deletionId",
       deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil",
       restore_until <= :time::timestamptz AS expired
FROM library.copy
WHERE route = :route::integer AND copy_id = :copy_id::uuid AND account_id = :account_id::uuid
FOR UPDATE;
