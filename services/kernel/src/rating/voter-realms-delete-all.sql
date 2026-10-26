DELETE FROM rating.voter_realm
WHERE route = :route::integer AND voter_id = :voter_id::uuid;
