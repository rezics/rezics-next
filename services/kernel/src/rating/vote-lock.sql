SELECT route, voter_id AS "voterId", question_id AS "questionId", target_id AS "targetId", units, revision,
       changed_at::text AS "changedAt", transaction_id AS "transactionId"
FROM rating.vote
WHERE route = :route AND voter_id = :voter_id::uuid AND question_id = :question_id::uuid
  AND target_id = :target_id::uuid
FOR UPDATE;
