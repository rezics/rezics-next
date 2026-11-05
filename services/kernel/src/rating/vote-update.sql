UPDATE rating.vote
SET units = :units::nullable(integer), revision = revision + 1, counted_target = :counted_target::uuid,
    counted_revision = :counted_revision::integer, changed_at = :changed_at::timestamptz,
    transaction_id = :transaction_id::uuid
WHERE route = :route AND voter_id = :voter_id::uuid AND question_id = :question_id::uuid
  AND target_id = :target_id::uuid AND revision = :revision
RETURNING route, voter_id AS "voterId", question_id AS "questionId", target_id AS "targetId",
          counted_target AS "countedTarget", counted_revision AS "countedRevision", units, revision,
          changed_at::text AS "changedAt", transaction_id AS "transactionId";
