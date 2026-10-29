WITH removed AS (
  DELETE FROM library.entry
  WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
    AND incarnation_id IS NOT NULL AND incarnation_id = :incarnation_id::uuid
    AND revision = :revision::integer AND revision <= 2147483644
  RETURNING *
)
INSERT INTO library.entry_deleted
  (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at,
   transaction_id, activity_at, finished_at, type_id, type_source_id, type_source_partition,
   type_source_epoch, type_source_position, incarnation_id, library_profile_pin, owner_write_seq,
   deletion_id, deleted_revision, deleted_at, restore_until)
SELECT route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at,
   transaction_id, activity_at, finished_at, type_id, type_source_id, type_source_partition,
   type_source_epoch, type_source_position, incarnation_id, library_profile_pin, owner_write_seq,
       :transaction_id::uuid, revision + 1, :time::timestamptz, :time::timestamptz + interval '720 hours'
FROM removed
RETURNING route, account_id AS "accountId", subject_id AS "subjectId",
       requested_subject_id AS "requestedSubjectId", state, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       transaction_id AS "transactionId", activity_at::text AS "activityAt",
       finished_at::text AS "finishedAt", type_id AS "typeId", type_source_id AS "typeSourceId",
       type_source_partition AS "typeSourcePartition", type_source_epoch AS "typeSourceEpoch",
       type_source_position::text AS "typeSourcePosition", incarnation_id AS "incarnationId",
       library_profile_pin AS "libraryProfilePin", owner_write_seq::text AS "ownerWriteSeq",
       deletion_id AS "deletionId", deleted_revision AS "deletedRevision",
       deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil";
