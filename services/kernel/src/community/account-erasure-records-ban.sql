-- A temporal primary-key point selects the one interval containing its own start.
UPDATE community.realm_ban
SET actor = NULL,
    reason = CASE WHEN :purge::boolean OR lower(valid) + interval '183 days' <= :erased_at::timestamptz
                  THEN '' ELSE reason END
WHERE route = :owner_route::integer AND realm_id = :owner_id::uuid AND account_id = :key::uuid
  AND valid @> (:due_at::timestamptz - interval '183 days') AND lower(valid) = (:due_at::timestamptz - interval '183 days')
  AND (actor = :account_id::uuid OR actor IS NULL)
RETURNING CASE WHEN reason <> '' AND lower(valid) + interval '183 days' > :erased_at::timestamptz
               THEN (lower(valid) + interval '183 days')::text END AS kept_until;
