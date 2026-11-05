WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT realm_id, space_id, discovery_epoch::text AS realm_epoch,
       discovery_epoch_started_at::text AS epoch_started_at
FROM community.realm CROSS JOIN input i
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND state = 'active' AND visibility = 'public'
  AND created_at <= i.at AND discovery_epoch_started_at <= i.at;
