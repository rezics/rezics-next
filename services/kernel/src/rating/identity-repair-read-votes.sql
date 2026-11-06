SELECT question_id AS "questionId",
       target_id AS "targetId",
       counted_target AS "countedTargetId",
       units,
       revision,
       counted_revision AS "countedRevision",
       to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changedAt",
       transaction_id AS "transactionId"
FROM rating.vote
WHERE route = $1::integer AND voter_id = $2::uuid
ORDER BY question_id, target_id;
