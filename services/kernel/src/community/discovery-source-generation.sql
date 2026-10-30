UPDATE community.realm SET discovery_generation = GREATEST(discovery_generation, :generation::bigint)
WHERE route = :route::integer AND realm_id = :realm_id::uuid RETURNING realm_id;
