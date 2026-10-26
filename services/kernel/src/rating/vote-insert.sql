INSERT INTO rating.vote
  (route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
VALUES
  (:route, :voter_id::uuid, :question_id::uuid, :target_id::uuid, :units, 1, :changed_at::timestamptz,
   :transaction_id::uuid)
RETURNING route, voter_id AS "voterId", question_id AS "questionId", target_id AS "targetId", units, revision,
          changed_at::text AS "changedAt", transaction_id AS "transactionId";
