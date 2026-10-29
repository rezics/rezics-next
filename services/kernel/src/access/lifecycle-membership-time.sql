-- The organization account lock serializes this monotone time with every role
-- change, including additions. Rollback also rolls back a refused guard advance.
UPDATE access.account
SET membership_time = GREATEST(membership_time, :at::timestamptz)
WHERE route = :route AND account_id = :organization_id AND kind = 'organization'
RETURNING membership_time::text AS at;
