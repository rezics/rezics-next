-- migrate:up
-- WITHOUT OVERLAPS retains temporal integrity. Its multidimensional GiST is
-- complemented by the ordered Global subject/action key for one predecessor probe.
CREATE INDEX resource_grant_pkey_lookup ON access.resource_grant
USING btree (subject_kind, subject_id, subject_role, action, valid) INCLUDE (route, resource_id)
WHERE route = 0 AND resource_id = '00000000-0000-8000-8000-000000000000'::uuid;

-- migrate:down
DROP INDEX access.resource_grant_pkey_lookup;
