SELECT state, cursor_question_id::text AS "cursorQuestionId", cursor_target_id::text AS "cursorTargetId",
       transition_id::text AS "transitionId", purge_votes AS "purgeVotes", populations::text[] AS populations
FROM rating.voter_state
WHERE route = :route AND voter_id = :voter_id::uuid
FOR UPDATE;
