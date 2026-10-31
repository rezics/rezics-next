DELETE FROM community.member_locator
WHERE route = :route::integer AND account_id = :account_id::uuid AND realm_id = ANY(:realm_ids::uuid[]);
