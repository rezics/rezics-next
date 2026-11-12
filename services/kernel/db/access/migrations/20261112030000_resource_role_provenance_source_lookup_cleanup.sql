-- migrate:up
DROP INDEX access.resource_role_provenance_source_lookup;

-- migrate:down
CREATE INDEX resource_role_provenance_source_lookup
  ON access.resource_role_provenance (route, resource_id, account_id, grant_role, source_transaction)
  WHERE side = 'new';
