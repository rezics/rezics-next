-- One current-key seek; closed ban history never widens the probe.
SELECT true AS banned
FROM community.realm_ban
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND account_id = :account_id::uuid AND upper_inf(valid)
  AND valid @> :at::timestamptz;
