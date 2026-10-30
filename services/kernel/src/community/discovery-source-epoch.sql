SELECT realm_id, space_id, discovery_epoch::text AS realm_epoch, discovery_generation::text AS generation,
       state, visibility
FROM community.realm WHERE route = :route::integer AND realm_id = :realm_id::uuid FOR UPDATE;
