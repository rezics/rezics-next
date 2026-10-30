-- migrate:up
ALTER TABLE community.party_locator DROP CONSTRAINT party_locator_kind_check;
ALTER TABLE community.party_locator ADD CONSTRAINT party_locator_kind_check
  CHECK (kind IN ('ban_target', 'ban_actor', 'membership_operation', 'verdict', 'claim_request'));

-- migrate:down
ALTER TABLE community.party_locator DROP CONSTRAINT party_locator_kind_check;
ALTER TABLE community.party_locator ADD CONSTRAINT party_locator_kind_check
  CHECK (kind IN ('ban_target', 'ban_actor', 'membership_operation', 'verdict'));
