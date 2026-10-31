-- migrate:up
-- Forward scheduling may pass a blocked phase, but this durable raw-page
-- checkpoint prevents scheduling from being mistaken for destructive completion.
ALTER TABLE access.erasure_native_progress ADD COLUMN retry_phase integer NOT NULL DEFAULT -1 CHECK (retry_phase >= -1);
CREATE TABLE access.erasure_native_blocked (
  progress_id uuid NOT NULL REFERENCES access.erasure_native_progress(progress_id),
  phase integer NOT NULL CHECK (phase >= 0),
  page integer NOT NULL CHECK (page >= 0),
  consumer_index integer NOT NULL DEFAULT 0 CHECK (consumer_index >= 0 AND consumer_index < 100),
  reason text NOT NULL CHECK (reason IN (
    'handle-consumer', 'membership-terminal-consumer', 'organization-close-consumer',
    'verification-decision-consumer', 'verification-reversal-consumer', 'controller-transition-consumer', 'rating-controller-projection-custody',
    'organization-cursor-cutover',
    'auth-fence-release-witness-unavailable', 'continuation-barrier-consumer', 'deletion-local-consumer'
  )),
  PRIMARY KEY (progress_id, phase)
);

-- These rows remain refusal markers. No personal identity or original command
-- provenance is needed to refuse a second initialization/bootstrap.
ALTER TABLE access.resource_initialization
  ALTER COLUMN creator_id DROP NOT NULL,
  ALTER COLUMN initialized_at DROP NOT NULL,
  ADD CONSTRAINT resource_initialization_attribution_check CHECK ((creator_id IS NULL) = (initialized_at IS NULL));
ALTER TABLE access.governance_bootstrap
  ALTER COLUMN account_id DROP NOT NULL,
  ALTER COLUMN transaction_id DROP NOT NULL,
  ADD CONSTRAINT governance_bootstrap_attribution_check CHECK ((account_id IS NULL) = (transaction_id IS NULL));

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Erased attribution cannot be restored'; END $$;
