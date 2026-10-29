SELECT route, account_id AS "accountId", subject_id AS "subjectId",
       requested_subject_id AS "requestedSubjectId", state, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       transaction_id AS "transactionId", activity_at::text AS "activityAt",
       finished_at::text AS "finishedAt", type_id AS "typeId", type_source_id AS "typeSourceId",
       type_source_partition AS "typeSourcePartition", type_source_epoch AS "typeSourceEpoch",
       type_source_position::text AS "typeSourcePosition", incarnation_id AS "incarnationId",
       library_profile_pin AS "libraryProfilePin", owner_write_seq::text AS "ownerWriteSeq",
       deletion_id AS "deletionId", deleted_revision AS "deletedRevision",
       deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil", restore_until <= :time::timestamptz AS expired
FROM library.entry_deleted
WHERE route = :route AND account_id = :account_id AND deletion_id = :deletion_id
  AND subject_id = :subject_id
FOR UPDATE;
