DELETE FROM rating.voter_realm
WHERE route = :route AND voter_id = :voter_id::uuid AND realm_id = :realm_id::uuid;
