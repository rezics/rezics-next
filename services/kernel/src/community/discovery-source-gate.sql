SELECT r.discovery_epoch::text AS realm_epoch, r.discovery_generation::text AS generation,
       NOT EXISTS (SELECT 1 FROM community.realm_discovery_fence f
         WHERE f.route = r.route AND f.realm_id = r.realm_id AND f.realm_epoch = r.discovery_epoch
           AND f.outcome IS NULL) AS settled
FROM community.realm r WHERE r.route = :route::integer AND r.realm_id = :realm_id::uuid;
