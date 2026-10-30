-- migrate:up
-- The temporal role predicate skips closed history; the partial index contains
-- only direct identity owners. No membership fanout or second owner store.
CREATE INDEX realm_owner_continuity ON access.resource_role_grant
USING gist (route, resource_id, valid)
INCLUDE (subject_id)
WHERE subject_kind = 'identity' AND subject_role = '' AND grant_role = 'community.realm.owner' AND upper_inf(valid);

-- migrate:down
DROP INDEX access.realm_owner_continuity;
