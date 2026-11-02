SELECT question_id AS "questionId", target_id AS "targetId"
FROM rating.vote
WHERE route = $1::integer AND voter_id = $2::uuid
ORDER BY question_id DESC, target_id DESC
LIMIT 1;
