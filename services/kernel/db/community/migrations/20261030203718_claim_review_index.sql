-- migrate:up
CREATE INDEX realm_claim_request_pending_review
  ON community.realm_claim_request (route, realm_id, orphaned_at, request_id)
  INCLUDE (account_id, requested_at) WHERE state = 'pending';

-- migrate:down
DROP INDEX community.realm_claim_request_pending_review;
