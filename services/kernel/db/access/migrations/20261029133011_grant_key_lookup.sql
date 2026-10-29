-- migrate:up
-- WITHOUT OVERLAPS retains temporal integrity. Its multidimensional GiST is
-- complemented by an ordered copy of the full key for one predecessor probe.
CREATE INDEX resource_grant_pkey_lookup ON access.resource_grant
USING btree (route, resource_id, subject_kind, subject_id, subject_role, action, valid);

-- migrate:down
DROP INDEX access.resource_grant_pkey_lookup;
