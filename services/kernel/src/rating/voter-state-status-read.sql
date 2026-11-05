SELECT state FROM rating.voter_state
WHERE route = :route::integer AND voter_id = :voter_id::uuid;
