WITH page AS MATERIALIZED (
  SELECT route, voter_id, realm_id
  FROM rating.voter_realm
  WHERE route = :route::integer AND voter_id = :voter_id::uuid
  ORDER BY realm_id
  LIMIT 100
  FOR UPDATE
)
DELETE FROM rating.voter_realm AS membership
USING page
WHERE membership.route = page.route AND membership.voter_id = page.voter_id
  AND membership.realm_id = page.realm_id
RETURNING membership.realm_id;
