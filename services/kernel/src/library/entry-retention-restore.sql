WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :deletion_id::uuid AS deletion_id
), retained AS MATERIALIZED (
  SELECT d.* FROM library.entry_deleted AS d CROSS JOIN input
  WHERE d.route = input.route AND d.account_id = input.account_id AND d.deletion_id = input.deletion_id
    AND d.subject_id = :subject_id AND d.deleted_revision = :deleted_revision::integer
    AND :time::timestamptz < d.restore_until
  FOR UPDATE OF d
), inserted AS (
  INSERT INTO library.entry
    (route, account_id, subject_id, requested_subject_id, state, revision, created_at, updated_at,
     transaction_id, activity_at, finished_at, type_id, type_source_id, type_source_partition,
     type_source_epoch, type_source_position, incarnation_id, library_profile_pin, owner_write_seq)
  SELECT route, account_id, subject_id, requested_subject_id, state, deleted_revision + 1, created_at, updated_at,
         :transaction_id::uuid, activity_at, finished_at, type_id, type_source_id, type_source_partition,
         type_source_epoch, type_source_position, incarnation_id, library_profile_pin, owner_write_seq
  FROM retained
  ON CONFLICT (route, account_id, subject_id) DO NOTHING
  RETURNING *
), consumed AS (
  DELETE FROM library.entry_deleted AS d USING input
  WHERE d.route = input.route AND d.account_id = input.account_id AND d.deletion_id = input.deletion_id
    AND EXISTS (SELECT 1 FROM inserted)
  RETURNING d.deletion_id
)
SELECT route, account_id AS "accountId", subject_id AS "subjectId",
       requested_subject_id AS "requestedSubjectId", state, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       transaction_id AS "transactionId", activity_at::text AS "activityAt",
       finished_at::text AS "finishedAt", type_id AS "typeId", type_source_id AS "typeSourceId",
       type_source_partition AS "typeSourcePartition", type_source_epoch AS "typeSourceEpoch",
       type_source_position::text AS "typeSourcePosition", incarnation_id AS "incarnationId",
       library_profile_pin AS "libraryProfilePin", owner_write_seq::text AS "ownerWriteSeq"
FROM inserted
WHERE EXISTS (SELECT 1 FROM consumed);
