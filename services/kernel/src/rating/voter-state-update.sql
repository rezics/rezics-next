UPDATE rating.voter_state
SET state = :state::text,
    cursor_question_id = :cursor_question_id::nullable(uuid),
    cursor_target_id = :cursor_target_id::nullable(uuid),
    transition_id = :transition_id::uuid,
    purge_votes = :purge_votes::boolean,
    populations = :populations::uuid[]
WHERE route = :route::integer AND voter_id = :voter_id::uuid;
