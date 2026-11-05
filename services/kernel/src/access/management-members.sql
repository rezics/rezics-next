-- Coordination is only a bounded candidate feed; the reader separately verifies every current native role.
SELECT member_account_id::text AS "accountId"
FROM access.lifecycle_membership_slot
WHERE route = :route AND organization_id = :organization_id AND NOT terminal
  AND member_account_id > :after::uuid
ORDER BY member_account_id
LIMIT :limit::integer;
