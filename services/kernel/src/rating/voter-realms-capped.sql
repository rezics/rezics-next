SELECT realm_id::text AS "realmId", state,
       cursor_question_id::text AS "cursorQuestionId", cursor_target_id::text AS "cursorTargetId",
       limit_question_id::text AS "limitQuestionId", limit_target_id::text AS "limitTargetId"
FROM rating.voter_realm
WHERE route = :route AND voter_id = :voter_id::uuid AND state <> 'uncounted'
ORDER BY realm_id
LIMIT 100;
