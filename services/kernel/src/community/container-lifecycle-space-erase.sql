UPDATE community.space
SET removed_by = NULL, removal_reason = NULL
WHERE route=:owner_route::integer AND space_id=:owner_id::uuid AND removed_by=:account_id::uuid
RETURNING space_id;
