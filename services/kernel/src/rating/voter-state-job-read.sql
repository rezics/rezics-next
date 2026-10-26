SELECT state, transition_id::text AS "transitionId", purge_votes AS "purgeVotes", populations::text[] AS populations
FROM rating.voter_state
WHERE route = :route::integer AND voter_id = :voter_id::uuid;
