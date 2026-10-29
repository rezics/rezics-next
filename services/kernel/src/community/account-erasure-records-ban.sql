WITH input AS NOT MATERIALIZED (
  SELECT :due_at::timestamptz AS due_at, :erased_at::timestamptz AS erased_at
)
-- A temporal primary-key point selects the one interval containing its own start.
UPDATE community.realm_ban
SET actor = NULL,
    reason = CASE WHEN :purge::boolean OR lower(valid) + interval '183 days' <= i.erased_at
                  THEN '' ELSE reason END
FROM input i
WHERE route = :owner_route::integer AND realm_id = :owner_id::uuid AND account_id = :key::uuid
  AND valid @> (i.due_at - interval '183 days') AND lower(valid) = (i.due_at - interval '183 days')
  AND (actor = :account_id::uuid OR actor IS NULL)
RETURNING CASE WHEN reason <> '' AND lower(valid) + interval '183 days' > i.erased_at
               THEN (lower(valid) + interval '183 days')::text END AS kept_until;
