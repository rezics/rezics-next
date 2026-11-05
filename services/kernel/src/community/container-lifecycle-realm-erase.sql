UPDATE community.realm
SET removed_by = NULL, removal_reason = NULL
WHERE route=:owner_route::integer AND realm_id=:owner_id::uuid AND removed_by=:account_id::uuid
RETURNING realm_id;
