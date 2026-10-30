-- migrate:up
-- A finite current explicit owner blocks a claim too. Keep history and group
-- grants out of the bounded current-holder predicate without another owner store.
CREATE INDEX realm_claim_current_owner ON access.resource_role_grant
USING gist (route, resource_id, valid)
WHERE subject_kind = 'identity' AND subject_role = '' AND grant_role = 'community.realm.owner';

-- migrate:down
DROP INDEX access.realm_claim_current_owner;
