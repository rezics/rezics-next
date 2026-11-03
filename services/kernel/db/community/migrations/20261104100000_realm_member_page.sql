-- migrate:up

-- A current membership row carries the publication transaction that committed it.
-- Keep that authoritative proof a point lookup even as one member's proof history grows.
CREATE INDEX realm_membership_proof_published_current
  ON community.realm_membership_proof (route, realm_id, account_id, transaction_id)
  WHERE outcome = 'published';

-- migrate:down
DROP INDEX community.realm_membership_proof_published_current;
