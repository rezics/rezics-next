-- migrate:up
-- Retain both container provenance and the independently delivered orphan-claim locator.
ALTER TABLE community.party_locator DROP CONSTRAINT party_locator_kind_check;
ALTER TABLE community.party_locator ADD CONSTRAINT party_locator_kind_check CHECK (kind IN
  ('ban_target', 'ban_actor', 'membership_operation', 'verdict', 'claim_request', 'space_remover', 'realm_remover'));

-- migrate:down
-- Forward only: account-erasure locators must retain every delivered record kind.
