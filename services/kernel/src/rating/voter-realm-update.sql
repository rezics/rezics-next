UPDATE rating.voter_realm
SET state = :state::text, cursor_question_id = :cursor_question_id::nullable(uuid), cursor_target_id = :cursor_target_id::nullable(uuid),
    limit_question_id = :limit_question_id::nullable(uuid), limit_target_id = :limit_target_id::nullable(uuid), rejoin = :rejoin::boolean,
    transition_id = :transition_id::uuid
WHERE route = :route AND voter_id = :voter_id::uuid AND realm_id = :realm_id::uuid;
