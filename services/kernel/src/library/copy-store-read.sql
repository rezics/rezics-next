SELECT copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
       acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
       library_profile_pin AS "libraryProfilePin", kind_profile_pin AS "kindProfilePin",
       status_profile_pin AS "statusProfilePin", media_condition AS "mediaCondition",
       packaging_condition AS "packagingCondition"
FROM library.copy
WHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id AND account_id = :account_id;
