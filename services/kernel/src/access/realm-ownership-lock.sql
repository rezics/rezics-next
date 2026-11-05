SELECT resource_id FROM access.resource_initialization
WHERE route = :route::integer AND resource_id = :resource_id::uuid AND resource_type = 'community.realm'
FOR UPDATE;
