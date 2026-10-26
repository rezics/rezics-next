SELECT state, cursor_question_id::text AS "cursorQuestionId", cursor_target_id::text AS "cursorTargetId",
       limit_question_id::text AS "limitQuestionId", limit_target_id::text AS "limitTargetId", rejoin,
       transition_id::text AS "transitionId"
FROM rating.voter_realm
WHERE route = :route AND voter_id = :voter_id::uuid AND realm_id = :realm_id::uuid
FOR UPDATE;
