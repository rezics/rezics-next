INSERT INTO rating.vote
  (route, voter_id, question_id, target_id, counted_target, counted_revision, units, revision, changed_at, transaction_id)
VALUES
  (:route, :voter_id::uuid, :question_id::uuid, :target_id::uuid, :counted_target::uuid, :counted_revision::integer,
   :units::nullable(integer), 1, :changed_at::timestamptz, :transaction_id::uuid)
RETURNING route, voter_id AS "voterId", question_id AS "questionId", target_id AS "targetId",
          counted_target AS "countedTarget", counted_revision AS "countedRevision", units, revision,
          changed_at::text AS "changedAt", transaction_id AS "transactionId";
