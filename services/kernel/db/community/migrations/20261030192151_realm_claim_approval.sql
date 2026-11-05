-- migrate:up
ALTER TABLE community.realm_claim_request DROP CONSTRAINT realm_claim_request_state_check;
ALTER TABLE community.realm_claim_request
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT realm_claim_request_state_check CHECK (state IN ('pending', 'approved')),
  ADD CONSTRAINT realm_claim_request_approval_check CHECK (
    (state = 'pending' AND approved_at IS NULL)
    OR (state = 'approved' AND approved_at IS NOT NULL AND isfinite(approved_at) AND approved_at >= requested_at)
  );

-- migrate:down
ALTER TABLE community.realm_claim_request
  DROP CONSTRAINT realm_claim_request_approval_check,
  DROP CONSTRAINT realm_claim_request_state_check,
  ADD CONSTRAINT realm_claim_request_state_check CHECK (state = 'pending'),
  DROP COLUMN approved_at;
