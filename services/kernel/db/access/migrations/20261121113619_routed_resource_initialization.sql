-- migrate:up
-- The marker's CHECK binds resource_id to its embedded route. Both grant
-- provenance and owner erasure can seek the (route, resource_id) primary key.
-- An ID-leading index puts unrelated UUIDv7 births on the same predicate page.
DROP INDEX access.erasure_resource_initialization_resource_id;

-- migrate:down
CREATE INDEX erasure_resource_initialization_resource_id ON access.resource_initialization (resource_id, route);
