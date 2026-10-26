SELECT EXISTS (
  SELECT 1
  FROM community.realm_member_terminal
  WHERE route = :route::integer
    AND realm_id = :realm_id::uuid
    AND account_id = :account_id::uuid
  LIMIT 1
) AS "hadMembership";
